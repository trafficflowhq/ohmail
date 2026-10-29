/**
 * I1 + I6 + I9 — THE RECORD LIFECYCLE: never lost, never hidden, never ambiguous on restore.
 *
 * ── WHY THESE RUN ON `IndexedDbMirrorStore` AND NOT THE MEMORY STORE ────────────────────────
 *
 * Every claim here is about what happens when a WRITE FAILS or a process DIES. `MemoryMirrorStore`
 * cannot fail a write and cannot be re-opened, so it would answer "fine" to all of it — the same
 * shape of blindness this repo already records for PGlite against transactional code. So: the real
 * browser store, over `fake-indexeddb`, with `putLocal`/`prune` stubbed to throw where the
 * assertion is about a storage fault.
 *
 * ── WHAT WAS TRUE BEFORE ────────────────────────────────────────────────────────────────────
 *
 * `abandon()` wrapped both its writes in one `try` with an empty `catch` and a comment claiming
 * the verb "stays queued". It did not: `dispatch` has already taken `p` off the queue by then, so
 * a failed write left the verb in NEITHER collection and nowhere in memory. And the boot's cache
 * invalidation sat below an early return that counts LIVE rows, so a boot with abandoned records
 * and an empty queue showed an empty list for the whole session.
 */
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { faultyFactory } from "./helpers/faulty-idb.js";
import { sqlWorld } from "./helpers/node-sql-executor.js";
import {
  CursorExpiredError,
  FixturesAdapter,
  IndexedDbMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  OUTBOX_ABANDONED_TYPE,
  OUTBOX_BACKOFF_CAP_MS,
  OUTBOX_ENTRY_VERSION,
  OUTBOX_MAX_SERVER_FAILURES,
  OUTBOX_TYPE,
  SqlMirrorStore,
  targetOf,
  type EngineMessage,
  type EngineMutation,
} from "@ohmail/client-engine";

const VERB: EngineMutation = { kind: "triage_set", messageId: "petra", state: "reply_later" } as EngineMutation;
const SERVER_500 = () => new MutationRejectedError("internal error", {
  status: 500, code: "internal", retryable: true,
});

function failingAdapter(inner: FixturesAdapter, onMutate: () => Error) {
  return {
    fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
    sync: (...a: Parameters<FixturesAdapter["sync"]>) => inner.sync(...a),
    mutate: async () => { throw onMutate(); },
  } as never;
}

const rows = (store: IndexedDbMirrorStore, type: string) => store.entries<unknown>(type);

/** Drive a verb to its ceiling through the road the drive actually uses. */
async function toCeiling(engine: OhmailEngine, advance: () => void) {
  await engine.mutate(VERB);
  for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES * 2; i++) {
    advance();
    await engine.syncOnce();
  }
}

describe("I1 — abandoning is failure-atomic", () => {
  /**
   * ── THESE TWO WERE GREEN OVER A STORE THAT DOES NOT EXIST ──────────────────────────────────
   *
   * The first version replaced `store.putLocal` and `store.prune` with rejecting functions. Those
   * reject WITHOUT touching memory; the real ones publish to `records` first and only then await
   * a flush that can fail. So the double could not produce the state the code actually reaches,
   * and both tests asserted the fix worked while the real store still had the defect.
   *
   * The faults now enter at the transaction — see `helpers/faulty-idb.ts` — which is also the only
   * seam that can express "the put landed and the delete did not", the shape the whole atomicity
   * claim is about.
   */
  it("a refused commit leaves the verb QUEUED with its attempts, and NOTHING in the abandoned collection", async () => {
    let t = Date.parse("2026-09-05T09:00:00.000Z");
    const faulty = faultyFactory(new IDBFactory());
    const store = new IndexedDbMirrorStore({ owner: "acct-i1-write", factory: faulty.factory });
    let calls = 0;
    const engine = new OhmailEngine({
      adapter: failingAdapter(new FixturesAdapter(), () => { calls += 1; return SERVER_500(); }),
      store,
      now: () => new Date(t),
    });
    await engine.start();

    // Armed only now: a store that cannot open is a different test.
    faulty.arm({ mode: "none", onWrite: (_op, key) => (key.startsWith("outbox_abandoned:") ? "quota" : "pass") });
    await toCeiling(engine, () => { t += OUTBOX_BACKOFF_CAP_MS + 1; });

    // The fault has to have FIRED, or every assertion below is about an ordinary run.
    expect(faulty.log.broken, "the injected storage fault never fired").toBeGreaterThan(0);

    // RED BEFORE THE FIX, in two different ways at two different times: first the verb was in
    // NEITHER collection (the swallowed catch lost it), then it was in BOTH (`putLocal` had
    // already published the abandoned row to memory before its flush was refused).
    expect(engine.abandoned()).toHaveLength(0);
    expect(rows(store, OUTBOX_ABANDONED_TYPE)).toHaveLength(0);
    const live = engine.pendingMutations().filter((p) => p.mutation.kind === "triage_set");
    expect(live).toHaveLength(1);
    expect(rows(store, OUTBOX_TYPE)).toHaveLength(1);

    // And it is a LIVE verb, not a corpse: storage recovers and the next drive abandons it
    // properly — one row, in one collection.
    faulty.heal();
    t += OUTBOX_BACKOFF_CAP_MS + 1;
    await engine.syncOnce();
    expect(engine.abandoned()).toHaveLength(1);
    expect(rows(store, OUTBOX_TYPE)).toHaveLength(0);
    expect(calls).toBeGreaterThan(OUTBOX_MAX_SERVER_FAILURES);
    store.close();
  });

  it("a transaction that aborts BETWEEN the put and the delete lands neither — and the reboot agrees", async () => {
    let t = Date.parse("2026-09-05T09:00:00.000Z");
    const real = new IDBFactory();
    const faulty = faultyFactory(real);
    const store = new IndexedDbMirrorStore({ owner: "acct-i1-del", factory: faulty.factory });
    const engine = new OhmailEngine({
      adapter: failingAdapter(new FixturesAdapter(), SERVER_500),
      store,
      now: () => new Date(t),
    });
    await engine.start();

    // THE PARTIAL FAILURE, and the reason this file exists: the abandoned row is written, then the
    // transaction goes down before the outbox row is deleted. Under the old two-call shape that
    // left BOTH rows on disk — a verb the strip offers Retry on while the queue is still running
    // it. Under one transaction it must leave NEITHER.
    // The put of the abandoned row passes; the delete of the live row in the SAME transaction
    // does not. Nothing else in the store is touched.
    faulty.arm({ mode: "none", onWrite: (op, key) =>
      (op === "delete" && key.startsWith("outbox_entry:") ? "abort" : "pass") });
    await toCeiling(engine, () => { t += OUTBOX_BACKOFF_CAP_MS + 1; });
    expect(faulty.log.broken, "the injected storage fault never fired").toBeGreaterThan(0);

    expect(rows(store, OUTBOX_ABANDONED_TYPE)).toHaveLength(0);
    expect(rows(store, OUTBOX_TYPE)).toHaveLength(1);
    store.close();

    // A fresh process over the same storage sees exactly one row, in the live collection — the
    // verb runs again. The invariant the whole table is checked against is this sum.
    faulty.heal();
    const store2 = new IndexedDbMirrorStore({ owner: "acct-i1-del", factory: real });
    const e2 = new OhmailEngine({
      adapter: failingAdapter(new FixturesAdapter(), SERVER_500),
      store: store2,
      now: () => new Date(t),
    });
    await e2.hydrate();
    expect(rows(store2, OUTBOX_TYPE)).toHaveLength(1);
    expect(rows(store2, OUTBOX_ABANDONED_TYPE)).toHaveLength(0);
    expect(e2.abandoned()).toHaveLength(0);
    store2.close();
  });
});

describe("I6 — a durable record is never hidden", () => {
  it("a boot with abandoned rows and an EMPTY live queue shows them on the first read", async () => {
    const factory = new IDBFactory();
    const t = Date.parse("2026-09-05T09:00:00.000Z");

    // Seed the exact state: one abandoned record, zero live outbox rows.
    const seed = new IndexedDbMirrorStore({ owner: "acct-i6", factory });
    await seed.load();
    await seed.putLocal(OUTBOX_ABANDONED_TYPE, "gone-1", {
      v: 3, id: "gone-1", key: "k-gone-1", n: 1, at: t - 1000, mutation: VERB,
      attempts: OUTBOX_MAX_SERVER_FAILURES,
      lastError: { message: "internal error", code: "internal", status: 500 },
    });
    seed.close();

    const store = new IndexedDbMirrorStore({ owner: "acct-i6", factory });
    const engine = new OhmailEngine({
      adapter: failingAdapter(new FixturesAdapter(), SERVER_500),
      store,
      now: () => new Date(t),
    });

    // The pre-hydration read the surface really makes on first paint. It caches `[]`.
    expect(engine.abandoned()).toHaveLength(0);

    await engine.hydrate();

    // RED BEFORE THE FIX, TWICE OVER: the invalidation sat below `if (!restored)` and then still
    // below the earlier `rows.length === 0` return. Both count LIVE verbs and neither says
    // anything about this collection, so the strip stayed empty for the session while the work
    // sat on disk — the feature rendering its own healthy state.
    expect(engine.abandoned()).toHaveLength(1);
    expect(engine.abandoned()[0]!.key).toBe("k-gone-1");
    store.close();
  });
});

describe("I9 — the persisted shape is versioned, and old records restore correctly", () => {
  const seedRecord = async (factory: IDBFactory, owner: string, entity: Record<string, unknown>) => {
    const seed = new IndexedDbMirrorStore({ owner, factory });
    await seed.load();
    await seed.putLocal(OUTBOX_TYPE, String(entity.id), entity);
    seed.close();
  };

  it("a v:1 record still restores and still replays", async () => {
    const factory = new IDBFactory();
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    await seedRecord(factory, "acct-v1", {
      v: 1, id: "legacy", key: "k-legacy", n: 1, at: t - 1000, mutation: VERB,
    });
    const store = new IndexedDbMirrorStore({ owner: "acct-v1", factory });
    let calls = 0;
    const engine = new OhmailEngine({
      adapter: failingAdapter(new FixturesAdapter(), () => { calls += 1; return SERVER_500(); }),
      store, now: () => new Date(t),
    });
    await engine.hydrate();
    await engine.syncOnce();
    // An upgrade must never orphan a verb the person already expressed.
    expect(calls).toBeGreaterThan(0);
    store.close();
  });

  it("a v:2 record written BEFORE the flag, carrying a wait, is obeyed as server-named", async () => {
    const factory = new IDBFactory();
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    await seedRecord(factory, "acct-v2pre", {
      // No `waitIsServerNamed` — the shape as it was written before the field existed.
      v: 2, id: "pre", key: "k-pre", n: 1, at: t - 1000, mutation: VERB,
      attempts: 1, nextAt: t + 60 * 60 * 1000,
    });
    const store = new IndexedDbMirrorStore({ owner: "acct-v2pre", factory });
    let calls = 0;
    const engine = new OhmailEngine({
      adapter: failingAdapter(new FixturesAdapter(), () => { calls += 1; return SERVER_500(); }),
      store, now: () => new Date(t),
    });
    await engine.hydrate();

    // `flushPending` is the explicit try-now road: it overrides OUR backoff and obeys the SERVER's.
    // Reading the absent flag as `false` would make this dispatch immediately, which is this client
    // overriding an interval the server chose — the one wait it has no right to override.
    await engine.flushPending();
    expect(calls).toBe(0);
    store.close();
  });
});

describe("I2 — a retry acts on ONE record and owns its outcome", () => {
  /** Two verbs: Q is driven to seven failures and left inside a long wait; A is abandoned. */
  async function twoRecords(owner: string, factory: IDBFactory) {
    let t = Date.parse("2026-09-05T09:00:00.000Z");
    const store = new IndexedDbMirrorStore({ owner, factory });
    let calls: string[] = [];
    let fail = true;
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => new FixturesAdapter().fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => new FixturesAdapter().sync(...a),
        mutate: async (m: EngineMutation) => {
          calls.push(m.kind);
          if (fail) throw SERVER_500();
          return { changes: [], seq: 1 };
        },
      } as never,
      store,
      now: () => new Date(t),
    });
    await engine.start();
    return {
      engine, store,
      calls: () => calls,
      reset: () => { calls = []; },
      stopFailing: () => { fail = false; },
      advance: (ms: number) => { t += ms; },
    };
  }

  it("retrying A does not dispatch unrelated Q, and does not spend Q's attempts", async () => {
    const factory = new IDBFactory();
    const w = await twoRecords("acct-i2-one", factory);

    // A: driven all the way to the ceiling.
    await w.engine.mutate({ kind: "triage_set", messageId: "petra", state: "reply_later" } as EngineMutation);
    for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES * 2; i++) {
      w.advance(OUTBOX_BACKOFF_CAP_MS + 1);
      await w.engine.syncOnce();
    }
    expect(w.engine.abandoned()).toHaveLength(1);
    const a = w.engine.abandoned()[0]!;

    // Q: seven counted failures, then left INSIDE its (long) backoff.
    await w.engine.mutate({ kind: "move", messageId: "giulia", to: "INBOX" } as unknown as EngineMutation);
    for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES - 2; i++) {
      w.advance(OUTBOX_BACKOFF_CAP_MS + 1);
      await w.engine.syncOnce();
    }
    const qBefore = w.engine.pendingMutations().find((p) => p.mutation.kind === "move");
    expect(qBefore, "Q must still be queued, not abandoned").toBeTruthy();
    const qAttempts = (qBefore as { attempts?: number }).attempts;

    w.reset();
    w.stopFailing();
    await w.engine.retryAbandoned(a.id);

    // RED BEFORE THE FIX: `retryAbandoned` called queue-wide `flushPending()`, which ignores every
    // client backoff — so Q was dispatched as collateral, and at seven failures that eighth
    // response abandoned it. A foreground press compressing another verb's hour into seconds.
    expect(w.calls()).toEqual(["triage_set"]);
    const qAfter = w.engine.pendingMutations().find((p) => p.mutation.kind === "move");
    expect(qAfter, "Q must not have been abandoned by A's retry").toBeTruthy();
    expect((qAfter as { attempts?: number }).attempts).toBe(qAttempts);
    w.store.close();
  });

  it("returns the MutationResult, so a retried send's `send_unverified` reaches the row", async () => {
    const factory = new IDBFactory();
    let t = Date.parse("2026-09-05T09:00:00.000Z");
    const store = new IndexedDbMirrorStore({ owner: "acct-i2-result", factory });
    let answer: () => never | { changes: never[]; seq: number } = () => { throw SERVER_500(); };
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => new FixturesAdapter().fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => new FixturesAdapter().sync(...a),
        mutate: async () => answer(),
      } as never,
      store, now: () => new Date(t),
    });
    await engine.start();

    await engine.mutate({ kind: "triage_set", messageId: "petra", state: "reply_later" } as EngineMutation);
    for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES * 2; i++) {
      t += OUTBOX_BACKOFF_CAP_MS + 1;
      await engine.syncOnce();
    }
    const rec = engine.abandoned()[0]!;

    answer = (() => { throw new MutationRejectedError(
      "We could not confirm this send. Check your Sent folder before retrying.",
      { status: 200, code: "send_unverified", retryable: false },
    ); }) as never;

    const out = await engine.retryAbandoned(rec.id);
    // RED BEFORE THE FIX: this answered a boolean, the surfaces discarded it, and the record had
    // already been deleted — so the sentence was said to nobody.
    expect(out.status).toBe("rolled_back");
    expect(out.error?.code).toBe("send_unverified");
    store.close();
  });

  it("refuses a superseded record with a coded result, and the refusal survives a reload", async () => {
    const factory = new IDBFactory();
    let t = Date.parse("2026-09-05T09:00:00.000Z");
    const store = new IndexedDbMirrorStore({ owner: "acct-i2-refuse", factory });
    const engine = new OhmailEngine({
      adapter: failingAdapter(new FixturesAdapter(), SERVER_500), store, now: () => new Date(t),
    });
    await engine.start();
    await engine.mutate({ kind: "triage_set", messageId: "petra", state: "reply_later" } as EngineMutation);
    for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES * 2; i++) {
      t += OUTBOX_BACKOFF_CAP_MS + 1;
      await engine.syncOnce();
    }
    const rec = engine.abandoned()[0]!;
    await engine.mutate({ kind: "triage_set", messageId: "petra", state: "none" } as EngineMutation);

    const out = await engine.retryAbandoned(rec.id);
    expect(out.status).toBe("rolled_back");
    expect(out.error?.code).toBe("outbox_superseded");
    // Durable: a control that keeps offering itself after every press is a no-op is worse than
    // no control, so the refusal is on disk and survives the reload.
    expect(engine.abandoned()[0]!.retryable).toBe(false);
    store.close();

    const store2 = new IndexedDbMirrorStore({ owner: "acct-i2-refuse", factory });
    const e2 = new OhmailEngine({
      adapter: failingAdapter(new FixturesAdapter(), SERVER_500), store: store2, now: () => new Date(t),
    });
    await e2.hydrate();
    expect(e2.abandoned()[0]!.retryable).toBe(false);
    expect(e2.abandoned()[0]!.refusedCode).toBe("outbox_superseded");
    store2.close();
  });
});

describe("I8 — one outbox dispatch at a time, and every one deadline-bounded", () => {
  it("two retries are serialized rather than run concurrently", async () => {
    const factory = new IDBFactory();
    let t = Date.parse("2026-09-05T09:00:00.000Z");
    const store = new IndexedDbMirrorStore({ owner: "acct-i8-serial", factory });
    let inFlight = 0;
    let maxConcurrent = 0;
    let release: (() => void) | null = null;
    let fail = true;
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => new FixturesAdapter().fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => new FixturesAdapter().sync(...a),
        mutate: async () => {
          if (fail) throw SERVER_500();
          inFlight += 1;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          await new Promise<void>((r) => { release = r; });
          inFlight -= 1;
          return { changes: [], seq: 1 };
        },
      } as never,
      store, now: () => new Date(t),
    });
    await engine.start();

    for (const id of ["petra", "giulia"]) {
      await engine.mutate({ kind: "triage_set", messageId: id, state: "reply_later" } as EngineMutation);
      for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES * 2; i++) {
        t += OUTBOX_BACKOFF_CAP_MS + 1;
        await engine.syncOnce();
      }
    }
    expect(engine.abandoned()).toHaveLength(2);
    fail = false;

    const [a, b] = engine.abandoned();
    const p1 = engine.retryAbandoned(a!.id);
    const p2 = engine.retryAbandoned(b!.id);
    // Real macrotask turns: `await Promise.resolve()` only drains microtasks, and the adapter's
    // body sits behind an `await`, so the first attempt had not reached it yet and nothing was
    // ever released — the test hung rather than failing.
    const tick = () => new Promise<void>((r) => { setTimeout(r, 1); });
    for (let i = 0; i < 50 && release === null; i++) await tick();
    release?.(); release = null;
    for (let i = 0; i < 50 && release === null; i++) await tick();
    release?.();
    await Promise.all([p1, p2]);

    // RED BEFORE THE FIX: `flushPending` had no single-flight and the per-record retry added a
    // third road, so two presses could be in the air at once — and for the null-key read verbs
    // that means a newer unread can land before an older read.
    expect(maxConcurrent).toBe(1);
    store.close();
  });

  it("a dispatch that never answers resolves `queued` at the deadline instead of hanging", async () => {
    const factory = new IDBFactory();
    let t = Date.parse("2026-09-05T09:00:00.000Z");
    const store = new IndexedDbMirrorStore({ owner: "acct-i8-deadline", factory });
    let fail = true;
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => new FixturesAdapter().fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => new FixturesAdapter().sync(...a),
        mutate: async () => {
          if (fail) throw SERVER_500();
          return new Promise<never>(() => { /* never answers — a half-open socket */ });
        },
      } as never,
      store, now: () => new Date(t),
      outboxReplayDeadlineMs: 20,
    } as never);
    await engine.start();
    await engine.mutate({ kind: "triage_set", messageId: "petra", state: "reply_later" } as EngineMutation);
    for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES * 2; i++) {
      t += OUTBOX_BACKOFF_CAP_MS + 1;
      await engine.syncOnce();
    }
    fail = false;

    // RED BEFORE THE FIX: the per-record retry was the one dispatch road with no deadline, so this
    // promise — and the surface spinner watching it — never settled.
    const out = await engine.retryAbandoned(engine.abandoned()[0]!.id);
    expect(out.status).toBe("queued");
    store.close();
  });
});

describe("I8 — the gate covers every road, not only the per-record retry", () => {
  it("a retry and a flush issued together are serialized", async () => {
    /**
     * WRITTEN TWICE, AND THE FIRST VERSION DID NOT BITE. It called `flushPending()` twice, but
     * that method drains the WHOLE queue into a batch before dispatching, so the second call finds
     * nothing and there is no concurrency to observe — removing the gate left it green.
     *
     * The hazard the review actually named is two DIFFERENT roads overlapping: a per-record retry
     * in flight while a flush starts behind it. That is the shape a surface produces — press Try
     * again, and a sync settles and flushes while the request is still open — and for the
     * read-flag verbs, whose supersession key is `null`, ordering is the whole contract.
     */
    const factory = new IDBFactory();
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const store = new IndexedDbMirrorStore({ owner: "acct-i8-roads", factory });
    let inFlight = 0;
    let maxConcurrent = 0;
    let fail = true;
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => new FixturesAdapter().fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => new FixturesAdapter().sync(...a),
        mutate: async () => {
          if (fail) throw SERVER_500();
          inFlight += 1;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          await new Promise<void>((r) => { setTimeout(r, 8); });
          inFlight -= 1;
          return { changes: [], seq: 1 };
        },
      } as never,
      store, now: () => new Date(t), outboxAutoReplay: false,
    } as never);
    await engine.start();

    // One record abandoned…
    let tt = t;
    await engine.mutate({ kind: "triage_set", messageId: "petra", state: "reply_later" } as EngineMutation);
    for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES * 2; i++) {
      tt += OUTBOX_BACKOFF_CAP_MS + 1;
      await engine.flushPending();
    }
    expect(engine.abandoned()).toHaveLength(1);

    // …and one verb sitting in the live QUEUE for the flush to pick up. It must be expressed while
    // the adapter is still refusing, or `mutate` dispatches it there and then and the flush below
    // has nothing to do — which is why the first version of this test could not fail.
    await engine.mutate({ kind: "triage_set", messageId: "giulia", state: "reply_later" } as EngineMutation);
    expect(engine.pendingMutations().length).toBeGreaterThan(0);
    fail = false;

    await Promise.all([
      engine.retryAbandoned(engine.abandoned()[0]!.id),
      engine.flushPending(),
    ]);

    expect(maxConcurrent).toBe(1);
    store.close();
  });
});

describe("I2 — a refusal that is not supersession is still durable", () => {
  it("an expired create refuses with `outbox_expired`, and the refusal survives a reload", async () => {
    // WRITTEN BECAUSE THE SUPERSEDED CASE DID NOT ISOLATE PERSISTENCE: `retryable` is already false
    // for a superseded record through its own flag, so deleting the `retryRefused` write left that
    // test green. An expired create carries no other flag, so only the persisted refusal can
    // answer — which is what makes this the case that proves the write.
    const factory = new IDBFactory();
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const seed = new IndexedDbMirrorStore({ owner: "acct-i2-expired", factory });
    await seed.load();
    await seed.putLocal(OUTBOX_ABANDONED_TYPE, "old-create", {
      v: 3, id: "old-create", key: "k-old-create", n: 1,
      // Older than the server's 24 h idempotency horizon: replaying it would MINT A SECOND ROW.
      at: t - (25 * 60 * 60 * 1000),
      mutation: { kind: "rule_create", match: "x@y.test", destination: "INBOX" },
      attempts: OUTBOX_MAX_SERVER_FAILURES,
      lastError: { message: "internal error", code: "internal", status: 500 },
    });
    seed.close();

    const store = new IndexedDbMirrorStore({ owner: "acct-i2-expired", factory });
    const engine = new OhmailEngine({
      adapter: failingAdapter(new FixturesAdapter(), SERVER_500), store, now: () => new Date(t),
    });
    await engine.hydrate();
    expect(engine.abandoned()).toHaveLength(1);

    const out = await engine.retryAbandoned("old-create");
    expect(out.status).toBe("rolled_back");
    expect(out.error?.code).toBe("outbox_expired");
    expect(engine.abandoned()[0]!.retryable).toBe(false);
    store.close();

    const store2 = new IndexedDbMirrorStore({ owner: "acct-i2-expired", factory });
    const e2 = new OhmailEngine({
      adapter: failingAdapter(new FixturesAdapter(), SERVER_500), store: store2, now: () => new Date(t),
    });
    await e2.hydrate();
    expect(e2.abandoned()[0]!.retryable).toBe(false);
    expect(e2.abandoned()[0]!.refusedCode).toBe("outbox_expired");
    store2.close();
  });
});

describe("I3 — supersession is about the TARGET, not the kind", () => {
  /** Abandon `older`, then express `newer`, and report whether the record was retired. */
  async function pair(owner: string, older: EngineMutation, newer: EngineMutation): Promise<boolean> {
    const factory = new IDBFactory();
    let t = Date.parse("2026-09-05T09:00:00.000Z");
    const store = new IndexedDbMirrorStore({ owner, factory });
    let fail = true;
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => new FixturesAdapter().fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => new FixturesAdapter().sync(...a),
        mutate: async () => { if (fail) throw SERVER_500(); return { changes: [], seq: 1 }; },
      } as never,
      store, now: () => new Date(t),
    });
    await engine.start();

    await engine.mutate(older);
    for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES * 2; i++) {
      t += OUTBOX_BACKOFF_CAP_MS + 1;
      await engine.flushPending();
      await engine.syncOnce();
    }
    if (engine.abandoned().length !== 1) {
      const q = engine.pendingMutations().length;
      store.close();
      throw new Error(`older verb did not abandon (kind=${older.kind}, queued=${q})`);
    }

    fail = false;
    await engine.mutate(newer);
    const retired = engine.abandoned()[0]?.superseded === true;
    store.close();
    return retired;
  }

  const msg = (kind: string, id = "petra") => ({ kind, messageId: id, state: "reply_later", to: "INBOX" } as unknown as EngineMutation);

  it("keys by target across kinds — the rule itself, pinned as a table", () => {
    /**
     * DIRECT, because reaching some of these end-to-end is not possible with fixture shapes: a
     * `draft_discard` or a `mail_send` naming an id the fixture world does not hold is refused
     * before it ever reaches the queue, so an end-to-end pair for those would prove that the
     * fixture rejects them, not that the rule is right. The wiring is proven by the two cases
     * below that DO drive.
     *
     * Each row is destructive if a stale record is retried, and each was invisible to a key that
     * included the KIND — the kinds differ, so nothing matched.
     */
    const t = (m: Record<string, unknown>) => targetOf(m as unknown as EngineMutation);

    // A draft: discard, save, schedule-cancel, accept and a send that NAMES it all collide.
    expect(t({ kind: "draft_discard", draftId: "d1" })).toBe("draft:d1");
    expect(t({ kind: "draft_save", draftId: "d1" })).toBe("draft:d1");
    expect(t({ kind: "draft_schedule_cancel", draftId: "d1" })).toBe("draft:d1");
    expect(t({ kind: "draft_accept", draftId: "d1" })).toBe("draft:d1");
    expect(t({ kind: "mail_send", draftId: "d1" })).toBe("draft:d1");

    // A folder: delete and rename collide.
    expect(t({ kind: "folder_delete", folderId: "f1" })).toBe("folder:f1");
    expect(t({ kind: "folder_rename", folderId: "f1" })).toBe("folder:f1");

    // A message: triage, move, delete and a tag assignment all name the same row.
    for (const kind of ["triage_set", "move", "message_delete", "tag_assign"]) {
      expect(t({ kind, messageId: "m1", tagId: "t1" }), kind).toBe("message:m1");
    }

    // Tags and rules by their own id.
    expect(t({ kind: "tag_delete", tagId: "t1" })).toBe("tag:t1");
    expect(t({ kind: "tag_rename", tagId: "t1" })).toBe("tag:t1");
    expect(t({ kind: "rule_delete", ruleId: "r1" })).toBe("rule:r1");
    expect(t({ kind: "rule_update", ruleId: "r1" })).toBe("rule:r1");

    // NULL — nothing an older record could overwrite. The creates name nothing yet; a send with no
    // draft owns no server row (the ruling's carve-out, and why such a send stays retryable);
    // the read verbs name a LIST and are handled by id subtraction instead.
    for (const kind of ["rule_create", "tag_create", "folder_create"]) {
      expect(t({ kind }), kind).toBeNull();
    }
    expect(t({ kind: "mail_send", draftId: null })).toBeNull();
    expect(t({ kind: "draft_save", draftId: null })).toBeNull();
    expect(t({ kind: "mark_seen", messageIds: ["a"] })).toBeNull();
    expect(t({ kind: "feed_mark_seen", messageIds: ["a"] })).toBeNull();
  });

  it("retires an abandoned record end-to-end when a newer verb names the same target", async () => {
    // ONE end-to-end pair, on the only target the fixture world actually holds: a message.
    // Folder and draft verbs naming ids the fixtures do not have are refused before they reach the
    // queue, so a pair built on those would prove the fixture rejects them and nothing about the
    // rule — which is what the table above is for. This proves the WIRING: `supersedeAbandoned`
    // is reached, reads `targetOf`, and marks across kinds (delete retired by a later move).
    expect(await pair("i3-c", msg("message_delete"), msg("move"))).toBe(true);
  });

  it("an unrelated target never retires a record", async () => {
    // The control: without it, an implementation that marks everything would satisfy every
    // assertion above.
    expect(await pair("i3-h", msg("triage_set", "petra"), msg("triage_set", "giulia"))).toBe(false);
  });
});

describe("I3 — the read verbs subtract ids rather than sharing a target", () => {
  /**
   * Seeded directly, because `mutate` refuses a verb naming ids the fixture world does not hold —
   * so an end-to-end pair would be testing the fixture. The newer verb IS expressed through
   * `mutate` (with real ids), so the path under test is the real `supersedeAbandoned`.
   */
  async function readPair(owner: string, olderIds: string[], newerIds: string[]): Promise<boolean> {
    const factory = new IDBFactory();
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const seed = new IndexedDbMirrorStore({ owner, factory });
    await seed.load();
    await seed.putLocal(OUTBOX_ABANDONED_TYPE, "older-read", {
      v: 3, id: "older-read", key: "k-older-read", n: 1, at: t - 1000,
      mutation: { kind: "mark_seen", messageIds: olderIds, unread: false },
      attempts: OUTBOX_MAX_SERVER_FAILURES,
      lastError: { message: "internal error", code: "internal", status: 500 },
    });
    seed.close();

    const store = new IndexedDbMirrorStore({ owner, factory });
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => new FixturesAdapter().fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => new FixturesAdapter().sync(...a),
        mutate: async () => ({ changes: [], seq: 1 }),
      } as never,
      store, now: () => new Date(t),
    });
    await engine.start();
    expect(engine.abandoned()).toHaveLength(1);

    await engine.mutate({ kind: "mark_seen", messageIds: newerIds, unread: true } as unknown as EngineMutation);
    const retired = engine.abandoned()[0]?.superseded === true;
    store.close();
    return retired;
  }

  it("a newer read verb covering every id retires the record", async () => {
    expect(await readPair("i3-read-full", ["giulia"], ["giulia", "petra"])).toBe(true);
  });

  it("a PARTIAL overlap leaves it alone — the untouched ids still carry an intent", async () => {
    // Retiring on partial overlap would silently drop the reader's word about `petra`, which
    // nothing else is going to deliver. This is the assertion the first version of the read test
    // was supposed to make and never reached, because its fixture ids were refused.
    expect(await readPair("i3-read-part", ["giulia", "petra"], ["giulia"])).toBe(false);
  });
});

describe("I6 — there is no invalidation line left to position wrongly", () => {
  it("the source contains ZERO manual `abandonedCache = null` assignments", async () => {
    /**
     * THE GUARD INVERTED, AND THAT IS THE FIX.
     *
     * This used to assert that `restoreOutbox`'s invalidation stood above every return. That
     * assertion was correct three times running and wrong three times running, because a position
     * is only correct until the next return is added above it: the line moved below
     * `if (!restored)`, then below `rows.length === 0`, then below the `outboxRestored` latch, and
     * each time a review found the new earlier return and each time the behavioural test passed
     * afterwards. A fourth move was not going to be the last one.
     *
     * `abandoned()` is now keyed on `store.version()`, which EVERY store write bumps — `putLocal`,
     * `commitLocal`, `prune`, `applyResponse`, `resetForBootstrap`, `adoptWipedBaseline`, `load()`.
     * A boot latch, a 410, a cross-tab adoption or a rejected commit therefore cannot leave the
     * snapshot stale, and there is no hand-placed line at all. So the rule this file enforces is
     * no longer "the line is above the returns" but "the line does not exist": re-introducing one
     * is re-introducing the whole class, and it fails here with the offending line quoted.
     */
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8").split("\n");
    const manual = src
      .map((text, i) => ({ line: i + 1, text: text.trim() }))
      .filter((x) => /this\.abandonedCache\s*=\s*null/.test(x.text));
    expect(
      manual,
      "abandoned() derives its freshness from store.version(); a hand-placed invalidation is the "
        + "bug class this guard exists to keep out",
    ).toEqual([]);
  });

  it("the cache is keyed on the store's version, and a store write is what refreshes it", async () => {
    /**
     * The behavioural half: the guard above says the manual line is gone, and this says the
     * mechanism that replaced it actually fires. Mutating `abandoned()` to cache unconditionally
     * (drop the `.v === v` test) makes this red; the source guard above cannot see that.
     */
    const factory = new IDBFactory();
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const store = new IndexedDbMirrorStore({ owner: "acct-i6-ver", factory });
    const engine = new OhmailEngine({
      adapter: new FixturesAdapter(), store, now: () => new Date(t),
    });
    await engine.start();
    expect(engine.abandoned()).toHaveLength(0);
    const before = engine.abandoned();

    // A write straight into the collection, behind the engine's back — the shape a cross-tab
    // adoption or a 410 carry-through produces, and the one a hand-placed invalidation missed.
    await store.putLocal(OUTBOX_ABANDONED_TYPE, "ver-1", {
      v: OUTBOX_ENTRY_VERSION, id: "ver-1", key: "k-ver-1", n: 1, at: t - 1000, mutation: VERB,
      attempts: OUTBOX_MAX_SERVER_FAILURES,
      lastError: { message: "server said no", code: null, status: 500 },
    });

    expect(engine.abandoned()).toHaveLength(1);
    expect(engine.abandoned()).not.toBe(before);
    // …and identity is stable across two reads at one version, or the strip re-renders for ever.
    expect(engine.abandoned()).toBe(engine.abandoned());
    store.close();
  });

  it("still invalidates when the restore body returns early — the latch case", async () => {
    // The specific hole the third round found: `syncOnce()` before storage loads latches the
    // restore against an empty store, so a later `hydrate()` reaches the latch return and, with
    // the invalidation behind it, never cleared the `[]` the surface had already cached.
    const factory = new IDBFactory();
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const seed = new IndexedDbMirrorStore({ owner: "acct-i6-latch", factory });
    await seed.load();
    await seed.putLocal(OUTBOX_ABANDONED_TYPE, "hidden-1", {
      v: 3, id: "hidden-1", key: "k-hidden-1", n: 1, at: t - 1000, mutation: VERB,
      attempts: OUTBOX_MAX_SERVER_FAILURES,
      lastError: { message: "internal error", code: "internal", status: 500 },
    });
    seed.close();

    const store = new IndexedDbMirrorStore({ owner: "acct-i6-latch", factory });
    const engine = new OhmailEngine({
      adapter: failingAdapter(new FixturesAdapter(), SERVER_500), store, now: () => new Date(t),
    });

    // Latch the restore BEFORE the store is loaded, then cache the empty reading a surface takes.
    engine.restoreOutbox();
    expect(engine.abandoned()).toHaveLength(0);

    await engine.hydrate();

    // The second call takes the latch return — and must still have invalidated on the way in.
    expect(engine.abandoned()).toHaveLength(1);
    expect(engine.abandoned()[0]!.key).toBe("k-hidden-1");
    store.close();
  });
});

describe("I8 — the queue flush is deadline-bounded too", () => {
  it("a dispatch that never answers resolves the flush instead of holding it open", async () => {
    // This loop awaited `dispatch` directly, so one half-open request held the flush — and every
    // caller awaiting it — open indefinitely. It was the road a host calls most often, and the
    // one that made "every send has a time limit" false.
    const factory = new IDBFactory();
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const store = new IndexedDbMirrorStore({ owner: "acct-i8-flushdl", factory });
    let hang = false;
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => new FixturesAdapter().fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => new FixturesAdapter().sync(...a),
        mutate: async () => {
          if (hang) return new Promise<never>(() => { /* a half-open socket */ });
          throw SERVER_500();
        },
      } as never,
      store, now: () => new Date(t), outboxAutoReplay: false, outboxReplayDeadlineMs: 20,
    } as never);
    await engine.start();

    await engine.mutate(VERB);              // queues (the adapter refuses)
    hang = true;

    const out = await engine.flushPending();   // must resolve at the deadline, not hang
    expect(out.some((r) => r.status === "queued")).toBe(true);
    store.close();
  });
});

describe("the 410 carry-through is the STORE's, and it has to reach DISK", () => {
  /**
   * ── THE HOLE THIS CLOSES ───────────────────────────────────────────────────────────────────
   *
   * `durable-outbox.test.ts` already asserts that a 410 does not eat the outbox — but it reads
   * `store.entries()`, which is MEMORY. When the carry-through moved out of the engine (snapshot,
   * wipe, write the rows back one at a time) and into the store's wipe transaction, that assertion
   * stopped covering the half that matters: `resetForBootstrap` keeps the rows in `records`
   * regardless, so deleting the re-put inside `wipe` leaves every existing test green and loses
   * every queued verb on the next boot. Measured: that mutation passed all 904 tests in this
   * package.
   *
   * A durability claim is a claim about what a DIFFERENT PROCESS finds. So this one reboots.
   */
  const seedAbandoned = async (store: IndexedDbMirrorStore, id: string, t: number) =>
    store.putLocal(OUTBOX_ABANDONED_TYPE, id, {
      v: OUTBOX_ENTRY_VERSION, id, key: `k-${id}`, n: 1, at: t - 1000, mutation: VERB,
      attempts: OUTBOX_MAX_SERVER_FAILURES,
      lastError: { message: "internal error", code: "internal", status: 500 },
    });

  const seedLive = async (store: IndexedDbMirrorStore, id: string, t: number) =>
    store.putLocal(OUTBOX_TYPE, id, {
      v: OUTBOX_ENTRY_VERSION, id, key: `k-${id}`, n: 0, at: t, mutation: VERB, attempts: 0,
    });

  it("five rows ride the wipe onto disk, and the next process finds all five", async () => {
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const real = new IDBFactory();
    const faulty = faultyFactory(real);
    const store = new IndexedDbMirrorStore({ owner: "acct-410-disk", factory: faulty.factory });
    const w = new FixturesAdapter();
    let expire = false;
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => w.fetchBody(...a),
        mutate: (...a: Parameters<FixturesAdapter["mutate"]>) => w.mutate(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => {
          if (expire) { expire = false; return Promise.reject(new CursorExpiredError()); }
          return w.sync(...a);
        },
      } as never,
      store,
      now: () => new Date(t),
    });
    await engine.start();

    for (const id of ["live-1", "live-2", "live-3"]) await seedLive(store, id, t);
    for (const id of ["gone-1", "gone-2"]) await seedAbandoned(store, id, t);
    expect(rows(store, OUTBOX_TYPE)).toHaveLength(3);
    expect(rows(store, OUTBOX_ABANDONED_TYPE)).toHaveLength(2);

    // ── the wipe's own transaction goes down ────────────────────────────────────────────────
    // A wipe that cannot happen is OWED, never forgotten, and an aborted transaction rolls back
    // the `clear()` with everything else — so the five rows are untouched on both sides.
    faulty.arm({ mode: "none", onWrite: (_op, key) => (key.startsWith("outbox") ? "abort" : "pass") });
    expire = true;
    // The drive REJECTS, and that is the contract: a store that cannot clear itself must write
    // nothing at all rather than proceed as though it had re-bootstrapped. `settleWipe` re-throws
    // for exactly this, and the wipe stays owed.
    await expect(engine.syncOnce()).rejects.toThrow();
    expect(faulty.log.broken, "the wipe's transaction was never broken").toBeGreaterThan(0);
    expect(rows(store, OUTBOX_TYPE)).toHaveLength(3);
    expect(rows(store, OUTBOX_ABANDONED_TYPE)).toHaveLength(2);

    // ── storage recovers; the owed wipe settles and carries them ────────────────────────────
    faulty.heal();
    expire = true;
    await engine.syncOnce();
    expect(rows(store, OUTBOX_TYPE)).toHaveLength(3);
    expect(rows(store, OUTBOX_ABANDONED_TYPE)).toHaveLength(2);
    store.close();

    // ── THE ASSERTION THE OLD TEST COULD NOT MAKE ───────────────────────────────────────────
    // A new process over the same database. Memory is gone; only what the wipe transaction
    // committed exists. Drop the `keep` re-put in `idb.ts`'s `wipe` and this is the only thing in
    // the package that notices.
    const store2 = new IndexedDbMirrorStore({ owner: "acct-410-disk", factory: real });
    await store2.load();
    expect(rows(store2, OUTBOX_TYPE), "the queued verbs did not survive the wipe").toHaveLength(3);
    expect(rows(store2, OUTBOX_ABANDONED_TYPE), "the abandoned records did not survive the wipe").toHaveLength(2);
    // No claim here about the server-derived rows: the drive that followed the wipe
    // re-bootstrapped them, which is the wipe working, not the wipe failing to happen. The
    // carve-out's other half — that a re-derivable client-local row does NOT ride through — is
    // the next test, where nothing re-drains to muddy it.
    store2.close();
  });

  it("a re-bootstrap discards the re-derivable client-local rows — the carve-out is the outbox alone", async () => {
    /**
     * The other half of the same rule, and the one a wider `keep` breaks silently: every seq-0 row
     * is client-local, but a `message_body` is re-fetched on demand. Keeping all of them would be
     * `adoptWipedBaseline`'s rule, which is right for a cross-tab adoption (nothing was lost, the
     * process is still live) and wrong for a 410 (the mirror is genuinely cold).
     */
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const real = new IDBFactory();
    const store = new IndexedDbMirrorStore({ owner: "acct-410-carve", factory: real });
    await store.load();
    await seedLive(store, "live-1", t);
    await store.putLocal("message_body", "giulia", { id: "giulia", html: "<p>body</p>" });
    expect(store.get("message_body", "giulia")).toBeDefined();

    await store.resetForBootstrap();
    expect(rows(store, OUTBOX_TYPE), "the queued verb must ride through").toHaveLength(1);
    expect(store.get("message_body", "giulia"), "a body is re-fetchable and must not ride through").toBeUndefined();
    store.close();

    const store2 = new IndexedDbMirrorStore({ owner: "acct-410-carve", factory: real });
    await store2.load();
    expect(rows(store2, OUTBOX_TYPE)).toHaveLength(1);
    expect(store2.get("message_body", "giulia")).toBeUndefined();
    store2.close();
  });
});

describe("a refused durable write: the send refuses, everything else proceeds", () => {
  /**
   * BOTH HALVES, because the asymmetry is the decision. A test that only pinned the send would
   * leave "refuse everything on a storage failure" looking like an improvement, and that would
   * cost the user real actions to protect them from a repeat that is a no-op.
   */
  const wireFor = (calls: string[]) => {
    const inner = new FixturesAdapter();
    return {
      fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
      sync: (...a: Parameters<FixturesAdapter["sync"]>) => inner.sync(...a),
      mutate: (m: EngineMutation, ...rest: unknown[]) => {
        calls.push(m.kind);
        return (inner.mutate as never as (...x: unknown[]) => unknown)(m, ...rest);
      },
    } as never;
  };

  it("a mail_send whose outbox row cannot be written is NEVER dispatched", async () => {
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const faulty = faultyFactory(new IDBFactory());
    const store = new IndexedDbMirrorStore({ owner: "acct-send-refused", factory: faulty.factory });
    const calls: string[] = [];
    const engine = new OhmailEngine({ adapter: wireFor(calls), store, now: () => new Date(t) });
    await engine.start();

    faulty.arm({ mode: "none", onWrite: (_op, key) => (key.startsWith("outbox_entry:") ? "quota" : "pass") });
    const res = await engine.mutate({
      kind: "mail_send", inReplyTo: null, mailboxId: "mbx-1", subject: "hello", body: "…",
      to: [{ name: null, address: "someone@example.test" }], cc: [], bcc: [],
    } as unknown as EngineMutation);

    // THE POINT: no POST. A send on the wire with no durable key is a message that can be
    // delivered a second time by the very next boot, and nothing can take it back.
    expect(calls).not.toContain("mail_send");
    expect(res.status).toBe("rolled_back");
    expect(res.error?.code).toBe("storage_refused");
    // …and the optimistic overlay is gone with it: a rolled-back send must not leave the UI
    // claiming it went.
    expect(rows(store, OUTBOX_TYPE)).toHaveLength(0);
    store.close();
  });

  it("a triage_set under the SAME fault still goes on the wire — the documented trade", async () => {
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const faulty = faultyFactory(new IDBFactory());
    const store = new IndexedDbMirrorStore({ owner: "acct-triage-refused", factory: faulty.factory });
    const calls: string[] = [];
    const engine = new OhmailEngine({ adapter: wireFor(calls), store, now: () => new Date(t) });
    await engine.start();

    faulty.arm({ mode: "none", onWrite: (_op, key) => (key.startsWith("outbox_entry:") ? "quota" : "pass") });
    const res = await engine.mutate(VERB);

    // Repeating it sets the same state again. Refusing it would cost the user their action to
    // protect them from nothing, so storage failing is not allowed to stop it.
    expect(calls).toContain("triage_set");
    expect(res.status).not.toBe("rolled_back");
    store.close();
  });
});

describe("the outbox has ONE write path, and the source says so", () => {
  it("no outbox row is ever written through `putLocal`, and only the terminal delete uses `prune`", async () => {
    /**
     * ── A CENSUS, BECAUSE THE DEFECT WAS A SECOND WRITER ───────────────────────────────────
     *
     * `commitLocal` is the outbox's write path: one transaction, memory published only when the
     * transaction resolved. Every behavioural guarantee in this file — no twins, no verb in
     * neither collection, no row live in memory that storage refused — holds only while that is
     * the ONLY way outbox rows are written. A single `putLocal(OUTBOX_ABANDONED_TYPE, …)` added
     * later re-opens the whole class, and it would do so quietly: the behavioural tests here
     * exercise the paths that exist today, not the one someone adds next month.
     *
     * The one carve-out is `dropOutbox`, whose lone terminal delete is deliberately `prune` —
     * three synchronous callers depend on its memory eviction landing before the first await, and
     * a lone delete has nothing to be atomic with. That method names its reasoning; this guard
     * pins the count at exactly one so the carve-out cannot quietly become the rule again.
     */
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8").split("\n");

    const putLocalWrites = src
      .map((text, i) => ({ line: i + 1, text: text.trim() }))
      .filter((x) => /\.putLocal\(\s*OUTBOX_/.test(x.text));
    expect(
      putLocalWrites,
      "an outbox row written through putLocal is published to memory before its flush can fail — "
        + "the twins defect, re-opened",
    ).toEqual([]);

    const pruneCalls = src
      .map((text, i) => ({ line: i + 1, text: text.trim() }))
      .filter((x) => /\.prune(Serialized)?\(\[\{\s*type:\s*OUTBOX_/.test(x.text));
    expect(
      pruneCalls.length,
      "exactly one prune of an outbox row is expected — dropOutbox's terminal delete, whose "
        + "durable half takes the store's write lane. Another one is a second write path, and the "
        + "reasoning for the first does not carry to it",
    ).toBe(1);
  });
});

describe("the refusal outlives the retry, because the ROW is its home", () => {
  /**
   * ── WHY A RESULT WAS NOT ENOUGH ────────────────────────────────────────────────────────────
   *
   * A refusal used to travel only in the `MutationResult`. For a verb someone is watching that
   * works. For a RESTORED verb it does not: `restored` means its caller died with the previous
   * session, so the result goes to a drive loop and nowhere else — and the row was dropped in the
   * same breath. The person queued something, closed the app, and came back to nothing at all:
   * no row, no sentence, no evidence it was ever expressed.
   *
   * The record is the only home an outcome has that outlives the retry, so the refusal is written
   * into it. Read tomorrow, after a reload, or on the other surface, the sentence is still there.
   */
  const seedRestorable = async (store: IndexedDbMirrorStore, id: string, t: number, m: EngineMutation) =>
    store.putLocal(OUTBOX_TYPE, id, {
      v: OUTBOX_ENTRY_VERSION, id, key: `k-${id}`, n: 0, at: t - 60_000, mutation: m, attempts: 0,
    });

  const refusingAdapter = (err: () => MutationRejectedError) => {
    const inner = new FixturesAdapter();
    return {
      fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
      sync: (...a: Parameters<FixturesAdapter["sync"]>) => inner.sync(...a),
      mutate: async () => { throw err(); },
    } as never;
  };

  it("a restored verb the server REFUSES leaves a record saying why, and it survives the next boot", async () => {
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const real = new IDBFactory();
    const seed = new IndexedDbMirrorStore({ owner: "acct-c3", factory: real });
    await seed.load();
    await seedRestorable(seed, "restored-1", t, VERB);
    seed.close();

    const store = new IndexedDbMirrorStore({ owner: "acct-c3", factory: real });
    const engine = new OhmailEngine({
      adapter: refusingAdapter(() => new MutationRejectedError(
        "that conversation is no longer in your mailbox",
        { status: 404, code: "not_found", retryable: false },
      )),
      store,
      now: () => new Date(t),
    });
    await engine.hydrate();
    expect(engine.pendingMutations()).toHaveLength(1);
    await engine.syncOnce();

    // NOT dropped. The row moved to the abandoned collection carrying the server's own sentence.
    expect(rows(store, OUTBOX_TYPE)).toHaveLength(0);
    const listed = engine.abandoned();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.error.message).toBe("that conversation is no longer in your mailbox");
    expect(listed[0]?.error.code).toBe("not_found");
    // A refusal that is not going to succeed on a second press must not offer one.
    expect(listed[0]?.retryable).toBe(false);
    store.close();

    // THE ASSERTION THE RESULT COULD NOT MAKE: a different process, and the sentence is still there.
    const store2 = new IndexedDbMirrorStore({ owner: "acct-c3", factory: real });
    const e2 = new OhmailEngine({ adapter: new FixturesAdapter(), store: store2, now: () => new Date(t) });
    await e2.hydrate();
    const after = e2.abandoned();
    expect(after).toHaveLength(1);
    expect(after[0]?.error.message).toBe("that conversation is no longer in your mailbox");
    store2.close();
  });

  it("`send_unverified` is the one refusal that KEEPS Retry — Try again on it is a verify, not a second message", async () => {
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const real = new IDBFactory();
    const SEND = {
      kind: "mail_send", inReplyTo: null, mailboxId: "mbx-1", subject: "hello", body: "…",
      to: [{ name: null, address: "someone@example.test" }], cc: [], bcc: [],
    } as unknown as EngineMutation;

    const seed = new IndexedDbMirrorStore({ owner: "acct-c3-unver", factory: real });
    await seed.load();
    await seedRestorable(seed, "restored-send", t, SEND);
    seed.close();

    const store = new IndexedDbMirrorStore({ owner: "acct-c3-unver", factory: real });
    const engine = new OhmailEngine({
      adapter: refusingAdapter(() => new MutationRejectedError(
        "the send was issued but its answer was lost",
        { status: null, code: "send_unverified", retryable: false },
      )),
      store,
      now: () => new Date(t),
    });
    await engine.hydrate();
    await engine.syncOnce();

    const listed = engine.abandoned();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.error.code).toBe("send_unverified");
    // The control STAYS. A person whose send may or may not have gone needs the action that
    // finds out; hiding it leaves them a row that says something went wrong and no way forward.
    expect(listed[0]?.retryable, "send_unverified must keep Retry — pressing it verifies under the same key").toBe(true);
    expect(listed[0]?.refusedCode).toBeNull();
    store.close();
  });
});

describe("a drive that runs before hydrate must not latch the restore over an empty store", () => {
  it("syncOnce() before hydrate() loses nothing: after hydrate the live verb and the abandoned record are both there", async () => {
    /**
     * ── THE SEQUENCE ───────────────────────────────────────────────────────────────────────
     *
     * `drive()` is reachable before `hydrate()` resolves — `mutate → dispatch → syncFresh` is the
     * short path, and a host that renders before it awaits the load takes it. The restore used to
     * be a single latched method, so that early drive ran it against a store holding nothing,
     * SET THE LATCH, and the previous session's verbs were never replayed for the rest of the
     * session. Nothing failed and nothing was logged; the queue was simply empty for ever.
     *
     * The fix is structural, not a reordering: `drive()` calls `restoreOutboxIfLoaded()`, which is
     * a no-op AND DOES NOT LATCH until the store has actually loaded — either through `hydrate()`
     * or because the host loaded it and called the public `restoreOutbox()` itself. There is no
     * arrangement of calls that can latch over an unloaded store, so this cannot come back as a
     * fourth ordering bug.
     */
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const real = new IDBFactory();
    const seed = new IndexedDbMirrorStore({ owner: "acct-c10", factory: real });
    await seed.load();
    await seed.putLocal(OUTBOX_TYPE, "live-1", {
      v: OUTBOX_ENTRY_VERSION, id: "live-1", key: "k-live-1", n: 0, at: t - 60_000,
      mutation: VERB, attempts: 0,
    });
    await seed.putLocal(OUTBOX_ABANDONED_TYPE, "gone-1", {
      v: OUTBOX_ENTRY_VERSION, id: "gone-1", key: "k-gone-1", n: 1, at: t - 90_000,
      mutation: VERB, attempts: OUTBOX_MAX_SERVER_FAILURES,
      lastError: { message: "internal error", code: "internal", status: 500 },
    });
    seed.close();

    const store = new IndexedDbMirrorStore({ owner: "acct-c10", factory: real });
    const engine = new OhmailEngine({
      adapter: failingAdapter(new FixturesAdapter(), SERVER_500),
      store,
      now: () => new Date(t),
    });

    // THE DRIVE FIRST, deliberately — no hydrate, no start. This is the call that used to latch.
    await engine.syncOnce().catch(() => { /* the drive's own outcome is not what this asserts */ });

    // Now the load the host was always going to do.
    await engine.hydrate();

    expect(
      engine.pendingMutations().map((p) => p.id),
      "the previous session's queued verb was latched away by the early drive",
    ).toEqual(["live-1"]);
    expect(
      engine.abandoned().map((a) => a.id),
      "the previous session's abandoned record was latched away by the early drive",
    ).toEqual(["gone-1"]);
    store.close();
  });
});

describe("the carve-out holds on the phone's store too", () => {
  /**
   * ── ONE RULE, TWO BACKENDS, AND THE SECOND ONE WAS UNCOVERED ───────────────────────────────
   *
   * The 410 carry-through is implemented twice — once in the IndexedDB wipe's transaction, once in
   * the sqlite wipe's batch — because the two stores persist differently. A rule with two
   * implementations needs two tests, and it did not have them: deleting the `keep` re-put from
   * `sql-store.ts` passed all 912 tests in this package, so every queued verb on a phone would be
   * lost on the first expired cursor and nothing would have said so.
   *
   * The sqlite half runs through `SqlExecutor.batch`, which the test's SQL runner implements as a real
   * `BEGIN IMMEDIATE`/`COMMIT` — faking it with sequential runs would make the atomicity claim
   * pass vacuously in the one place it has to be able to fail.
   */
  it("the outbox rides the wipe and a re-derivable body does not — and a reboot over the same database agrees", async () => {
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const world = sqlWorld();
    const store = new SqlMirrorStore({ owner: "origin|acct-carve", open: world.open });
    await store.load();

    await store.putLocal(OUTBOX_TYPE, "live-1", {
      v: OUTBOX_ENTRY_VERSION, id: "live-1", key: "k-live-1", n: 0, at: t, mutation: VERB, attempts: 0,
    });
    await store.putLocal(OUTBOX_ABANDONED_TYPE, "gone-1", {
      v: OUTBOX_ENTRY_VERSION, id: "gone-1", key: "k-gone-1", n: 1, at: t - 1000, mutation: VERB,
      attempts: OUTBOX_MAX_SERVER_FAILURES,
      lastError: { message: "internal error", code: "internal", status: 500 },
    });
    await store.putLocal("message_body", "giulia", { id: "giulia", html: "<p>body</p>" });

    await store.resetForBootstrap();
    expect(store.entries(OUTBOX_TYPE)).toHaveLength(1);
    expect(store.entries(OUTBOX_ABANDONED_TYPE)).toHaveLength(1);
    expect(store.get("message_body", "giulia")).toBeUndefined();
    store.close();

    // A different process over the same database file. Only what the wipe's batch committed exists.
    const store2 = new SqlMirrorStore({ owner: "origin|acct-carve", open: world.open });
    await store2.load();
    expect(store2.entries(OUTBOX_TYPE), "the queued verb did not survive the wipe").toHaveLength(1);
    expect(store2.entries(OUTBOX_ABANDONED_TYPE), "the abandoned record did not survive the wipe").toHaveLength(1);
    expect(store2.get("message_body", "giulia")).toBeUndefined();
    store2.close();
  });
});

describe("I8 — a fresh verb arriving mid-replay takes the same lane", () => {
  /**
   * ── THE ROAD THAT WAS NEVER IN THE LANE ────────────────────────────────────────────────────
   *
   * `retryAbandoned` and `flushPending` went through `outboxGate`. `mutate` and `replayOutbox`
   * did not — they used a private `replayActive` deferred, which serialized them against each
   * other and against nothing else. So a verb expressed while the boot replay was running could
   * be on the wire beside a replayed one.
   *
   * For the read verbs that is the whole contract. Their supersession key is `null`, so nothing
   * retires them and nothing orders them but the lane: a newer `unread` landing before an older
   * `read` leaves the server at the older value, and no later drain notices, because both
   * requests succeeded. The mailbox is simply wrong from then on.
   *
   * The adapter here records the order in which requests REACH IT and counts overlap, because
   * "serialized" is a claim about the wire and not about the promise the caller holds.
   */
  it("a mutate issued mid-replay reaches the wire AFTER the replayed verb, and never beside it", async () => {
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const real = new IDBFactory();

    // A warm mirror first: the fresh verb below needs a real target, and a store holding only
    // an outbox row has no messages until a drain runs — which is the very thing this test
    // stalls. A cold mirror made the fresh verb roll back `not_found` and the ordering
    // assertion passed for the wrong reason.
    const warm = new IndexedDbMirrorStore({ owner: "acct-i8-lane", factory: real });
    const warmer = new OhmailEngine({
      adapter: new FixturesAdapter(), store: warm, now: () => new Date(t),
    });
    await warmer.start();
    warm.close();

    // A verb from a previous session, waiting on disk.
    const seed = new IndexedDbMirrorStore({ owner: "acct-i8-lane", factory: real });
    await seed.load();
    await seed.putLocal(OUTBOX_TYPE, "replayed-1", {
      v: OUTBOX_ENTRY_VERSION, id: "replayed-1", key: "k-replayed-1", n: 0, at: t - 60_000,
      mutation: { kind: "mark_seen", messageIds: ["giulia"], unread: false },
      attempts: 0,
    });
    seed.close();

    const order: string[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    let releaseReplay: (() => void) | null = null;
    const inner = new FixturesAdapter();
    const store = new IndexedDbMirrorStore({ owner: "acct-i8-lane", factory: real });
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => inner.sync(...a),
        mutate: async (m: EngineMutation, o: { idempotencyKey: string }) => {
          inFlight += 1;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          order.push(o.idempotencyKey === "k-replayed-1" ? "replayed" : "fresh");
          // Hold the REPLAYED request open, so a fresh verb expressed now has every chance to
          // overtake it. Before the gate covered this road, it did.
          if (o.idempotencyKey === "k-replayed-1") {
            await new Promise<void>((r) => { releaseReplay = r; });
          }
          inFlight -= 1;
          return { changes: [], seq: 1 };
        },
      } as never,
      store,
      now: () => new Date(t),
    });
    await engine.hydrate();
    expect(engine.pendingMutations()).toHaveLength(1);

    const macrotick = () => new Promise<void>((r) => { setTimeout(r, 1); });
    const drive = engine.syncOnce();
    for (let i = 0; i < 50 && releaseReplay === null; i++) await macrotick();
    expect(releaseReplay, "the replayed verb never reached the wire").not.toBeNull();

    // The fresh verb, expressed while the replayed request is still open.
    const fresh = engine.mutate({
      kind: "mark_seen", messageIds: ["giulia"], unread: true,
    } as EngineMutation);
    for (let i = 0; i < 20; i++) await macrotick();

    // IT HAS NOT REACHED THE WIRE. Not queued-and-forgotten, not refused — waiting its turn.
    expect(order, "the fresh verb overtook the replayed one").toEqual(["replayed"]);

    releaseReplay!();
    const fr = await fresh;
    expect(fr.status, "the fresh verb must reach the wire, not roll back").not.toBe("rolled_back");
    await drive;
    for (let i = 0; i < 20; i++) await macrotick();

    expect(order).toEqual(["replayed", "fresh"]);
    expect(maxConcurrent, "two outbox requests were open at once").toBe(1);
    store.close();
  });
});

describe("a durable commit and a re-bootstrap never interleave", () => {
  /**
   * ── THE ROUND-FOUR CRITICAL, AND WHY THIS TEST LOOKS LIKE THIS ─────────────────────────────
   *
   * A reset decides which rows survive by reading `records`. A commit does not appear in
   * `records` until its transaction has already committed to disk — that is write-then-publish.
   * Overlap them and the wipe can clear a row the commit already wrote, while `putOutbox` has
   * answered success and the verb has gone to the server. A kill then leaves the next boot with
   * no key, and the next press mints a fresh one: a second message nobody can take back.
   *
   * THE FIRST VERSION OF THIS TEST JUST CALLED BOTH AND HOPED. It passed with the lane removed,
   * because the dangerous interleaving is about one microtask wide and the run happened to get
   * the safe order — the wipe's transaction landed before the commit's. A guard that depends on
   * which of two transactions the backend happens to schedule first is not a guard; it is a coin
   * that will land heads in CI for months and then stop.
   *
   * So the timing is HELD rather than hoped for. `SqlExecutor.batch` is a seam the test owns
   * completely, so the commit's write can be suspended for as long as the assertion needs, and
   * the question becomes a plain one with a definite answer: while a durable commit is in flight,
   * has the reset taken effect? Under the lane it cannot have. Without it, it already has.
   */

  /**
   * ── THE ROUND-FOUR CRITICAL ────────────────────────────────────────────────────────────────
   *
   * A reset decides which rows survive by reading `records`. A commit does not appear in
   * `records` until its transaction has already committed to disk — that is the whole point of
   * write-then-publish. Those two facts contradict each other the moment they overlap:
   *
   *   the send's transaction opens · the reset snapshots `records` and does not see it · the
   *   send's transaction commits and publishes · the wipe runs with the stale snapshot and
   *   re-puts only what it saw.
   *
   * The row is then in memory and NOT on disk, while `putOutbox` has already answered success and
   * the send has gone to the server. A kill before the answer leaves the next boot with no key,
   * and the next press mints a fresh one — a second message nobody can take back.
   *
   * No fault injection here: the interleaving is ordinary async ordering. `resetForBootstrap`
   * reads `records` before its first await, so starting it while a commit is suspended is enough.
   * That is worth saying plainly — the window is not exotic, it is the default.
   */
  const seedEntry = (id: string, t: number) => ({
    v: OUTBOX_ENTRY_VERSION, id, key: `k-${id}`, n: 0, at: t, mutation: VERB, attempts: 0,
  });

  it("while a durable commit is in flight, a re-bootstrap has NOT taken effect", async () => {
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const world = sqlWorld();
    let hold: Promise<void> | null = null;
    let release!: () => void;

    // The seam the test owns: every batch waits on `hold` while it is set.
    const open = (name: string) => {
      const inner = world.open(name);
      return {
        all: inner.all.bind(inner),
        batch: async (statements: Parameters<typeof inner.batch>[0]) => {
          if (hold) await hold;
          return inner.batch(statements);
        },
        close: inner.close?.bind(inner),
      } as typeof inner;
    };

    const store = new SqlMirrorStore({ owner: "origin|acct-race", open });
    await store.load();
    await store.putLocal(OUTBOX_TYPE, "older-1", seedEntry("older-1", t - 1000));
    // A server-derived row, so the reset has something visible to clear.
    await store.applyChanges([{ seq: 5, type: "message", id: "m1", op: "upsert",
      entity: { id: "m1", subject: "x" } } as unknown as SyncChange]);
    expect(store.get("message", "m1")).toBeDefined();

    hold = new Promise<void>((r) => { release = r; });
    const commit = store.commitLocal([{ type: OUTBOX_TYPE, id: "inflight-1",
      entity: seedEntry("inflight-1", t) }], []);
    const reset = store.resetForBootstrap();

    // Let every microtask and macrotask that CAN run, run. The commit is suspended in its batch;
    // the reset is either queued behind it (correct) or has already emptied the mirror (the bug).
    for (let i = 0; i < 10; i++) await new Promise<void>((r) => { setTimeout(r, 0); });
    expect(
      store.get("message", "m1"),
      "the re-bootstrap ran while a durable commit was still in flight — its snapshot cannot "
        + "contain that commit, so the wipe can clear a row the commit already wrote",
    ).toBeDefined();

    release();
    hold = null;
    await Promise.all([commit, reset]);

    // And the durability claim itself, from a second process over the same database.
    store.close();
    const store2 = new SqlMirrorStore({ owner: "origin|acct-race", open });
    await store2.load();
    const ids = store2.entries(OUTBOX_TYPE).map((r) => r.id).sort();
    expect(ids, "a queued verb was lost across the re-bootstrap").toEqual(["inflight-1", "older-1"]);
    expect(store2.get("message", "m1"), "the reset did not do its job").toBeUndefined();
    store2.close();
  });

  it("a commit issued during a reset lands AFTER it, on the new baseline", async () => {
    // The other direction. The wipe moves the generation forward; a commit that queued behind it
    // must write against the new baseline rather than being fenced off it. Wrong this way round
    // the row is refused rather than erased — quieter, and just as lost.
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const real = new IDBFactory();
    const store = new IndexedDbMirrorStore({ owner: "acct-race-2", factory: real });
    await store.load();

    const reset = store.resetForBootstrap();
    const commit = store.commitLocal([{ type: OUTBOX_TYPE, id: "after-1",
      entity: seedEntry("after-1", t) }], []);
    await Promise.all([reset, commit]);
    store.close();

    const store2 = new IndexedDbMirrorStore({ owner: "acct-race-2", factory: real });
    await store2.load();
    expect(
      store2.entries(OUTBOX_TYPE).map((r) => r.id),
      "a commit that queued behind the reset was fenced off the new baseline",
    ).toEqual(["after-1"]);
    store2.close();
  });
});

describe("the outbox has ONE write path, and the source says so", () => {
  it("no outbox row is ever written through `putLocal`, and only the terminal delete uses `prune`", async () => {
    /**
     * ── A CENSUS, BECAUSE THE DEFECT WAS A SECOND WRITER ───────────────────────────────────
     *
     * `commitLocal` is the outbox's write path: one transaction, memory published only when the
     * transaction resolved. Every behavioural guarantee in this file — no twins, no verb in
     * neither collection, no row live in memory that storage refused — holds only while that is
     * the ONLY way outbox rows are written. A single `putLocal(OUTBOX_ABANDONED_TYPE, …)` added
     * later re-opens the whole class, and it would do so quietly: the behavioural tests here
     * exercise the paths that exist today, not the one someone adds next month.
     *
     * The one carve-out is `dropOutbox`, whose lone terminal delete is deliberately `prune` —
     * three synchronous callers depend on its memory eviction landing before the first await, and
     * a lone delete has nothing to be atomic with. That method names its reasoning; this guard
     * pins the count at exactly one so the carve-out cannot quietly become the rule again.
     */
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8").split("\n");

    const putLocalWrites = src
      .map((text, i) => ({ line: i + 1, text: text.trim() }))
      .filter((x) => /\.putLocal\(\s*OUTBOX_/.test(x.text));
    expect(
      putLocalWrites,
      "an outbox row written through putLocal is published to memory before its flush can fail — "
        + "the twins defect, re-opened",
    ).toEqual([]);

    const pruneCalls = src
      .map((text, i) => ({ line: i + 1, text: text.trim() }))
      .filter((x) => /\.prune(Serialized)?\(\[\{\s*type:\s*OUTBOX_/.test(x.text));
    expect(
      pruneCalls.length,
      "exactly one prune of an outbox row is expected — dropOutbox's terminal delete, whose "
        + "durable half takes the store's write lane. Another one is a second write path, and the "
        + "reasoning for the first does not carry to it",
    ).toBe(1);
  });
});

describe("the refusal outlives the retry, because the ROW is its home", () => {
  /**
   * ── WHY A RESULT WAS NOT ENOUGH ────────────────────────────────────────────────────────────
   *
   * A refusal used to travel only in the `MutationResult`. For a verb someone is watching that
   * works. For a RESTORED verb it does not: `restored` means its caller died with the previous
   * session, so the result goes to a drive loop and nowhere else — and the row was dropped in the
   * same breath. The person queued something, closed the app, and came back to nothing at all:
   * no row, no sentence, no evidence it was ever expressed.
   *
   * The record is the only home an outcome has that outlives the retry, so the refusal is written
   * into it. Read tomorrow, after a reload, or on the other surface, the sentence is still there.
   */
  const seedRestorable = async (store: IndexedDbMirrorStore, id: string, t: number, m: EngineMutation) =>
    store.putLocal(OUTBOX_TYPE, id, {
      v: OUTBOX_ENTRY_VERSION, id, key: `k-${id}`, n: 0, at: t - 60_000, mutation: m, attempts: 0,
    });

  const refusingAdapter = (err: () => MutationRejectedError) => {
    const inner = new FixturesAdapter();
    return {
      fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
      sync: (...a: Parameters<FixturesAdapter["sync"]>) => inner.sync(...a),
      mutate: async () => { throw err(); },
    } as never;
  };

  it("a restored verb the server REFUSES leaves a record saying why, and it survives the next boot", async () => {
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const real = new IDBFactory();
    const seed = new IndexedDbMirrorStore({ owner: "acct-c3", factory: real });
    await seed.load();
    await seedRestorable(seed, "restored-1", t, VERB);
    seed.close();

    const store = new IndexedDbMirrorStore({ owner: "acct-c3", factory: real });
    const engine = new OhmailEngine({
      adapter: refusingAdapter(() => new MutationRejectedError(
        "that conversation is no longer in your mailbox",
        { status: 404, code: "not_found", retryable: false },
      )),
      store,
      now: () => new Date(t),
    });
    await engine.hydrate();
    expect(engine.pendingMutations()).toHaveLength(1);
    await engine.syncOnce();

    // NOT dropped. The row moved to the abandoned collection carrying the server's own sentence.
    expect(rows(store, OUTBOX_TYPE)).toHaveLength(0);
    const listed = engine.abandoned();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.error.message).toBe("that conversation is no longer in your mailbox");
    expect(listed[0]?.error.code).toBe("not_found");
    // A refusal that is not going to succeed on a second press must not offer one.
    expect(listed[0]?.retryable).toBe(false);
    store.close();

    // THE ASSERTION THE RESULT COULD NOT MAKE: a different process, and the sentence is still there.
    const store2 = new IndexedDbMirrorStore({ owner: "acct-c3", factory: real });
    const e2 = new OhmailEngine({ adapter: new FixturesAdapter(), store: store2, now: () => new Date(t) });
    await e2.hydrate();
    const after = e2.abandoned();
    expect(after).toHaveLength(1);
    expect(after[0]?.error.message).toBe("that conversation is no longer in your mailbox");
    store2.close();
  });

  it("`send_unverified` is the one refusal that KEEPS Retry — Try again on it is a verify, not a second message", async () => {
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const real = new IDBFactory();
    const SEND = {
      kind: "mail_send", inReplyTo: null, mailboxId: "mbx-1", subject: "hello", body: "…",
      to: [{ name: null, address: "someone@example.test" }], cc: [], bcc: [],
    } as unknown as EngineMutation;

    const seed = new IndexedDbMirrorStore({ owner: "acct-c3-unver", factory: real });
    await seed.load();
    await seedRestorable(seed, "restored-send", t, SEND);
    seed.close();

    const store = new IndexedDbMirrorStore({ owner: "acct-c3-unver", factory: real });
    const engine = new OhmailEngine({
      adapter: refusingAdapter(() => new MutationRejectedError(
        "the send was issued but its answer was lost",
        { status: null, code: "send_unverified", retryable: false },
      )),
      store,
      now: () => new Date(t),
    });
    await engine.hydrate();
    await engine.syncOnce();

    const listed = engine.abandoned();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.error.code).toBe("send_unverified");
    // The control STAYS. A person whose send may or may not have gone needs the action that
    // finds out; hiding it leaves them a row that says something went wrong and no way forward.
    expect(listed[0]?.retryable, "send_unverified must keep Retry — pressing it verifies under the same key").toBe(true);
    expect(listed[0]?.refusedCode).toBeNull();
    store.close();
  });
});

describe("a drive that runs before hydrate must not latch the restore over an empty store", () => {
  it("syncOnce() before hydrate() loses nothing: after hydrate the live verb and the abandoned record are both there", async () => {
    /**
     * ── THE SEQUENCE ───────────────────────────────────────────────────────────────────────
     *
     * `drive()` is reachable before `hydrate()` resolves — `mutate → dispatch → syncFresh` is the
     * short path, and a host that renders before it awaits the load takes it. The restore used to
     * be a single latched method, so that early drive ran it against a store holding nothing,
     * SET THE LATCH, and the previous session's verbs were never replayed for the rest of the
     * session. Nothing failed and nothing was logged; the queue was simply empty for ever.
     *
     * The fix is structural, not a reordering: `drive()` calls `restoreOutboxIfLoaded()`, which is
     * a no-op AND DOES NOT LATCH until the store has actually loaded — either through `hydrate()`
     * or because the host loaded it and called the public `restoreOutbox()` itself. There is no
     * arrangement of calls that can latch over an unloaded store, so this cannot come back as a
     * fourth ordering bug.
     */
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const real = new IDBFactory();
    const seed = new IndexedDbMirrorStore({ owner: "acct-c10", factory: real });
    await seed.load();
    await seed.putLocal(OUTBOX_TYPE, "live-1", {
      v: OUTBOX_ENTRY_VERSION, id: "live-1", key: "k-live-1", n: 0, at: t - 60_000,
      mutation: VERB, attempts: 0,
    });
    await seed.putLocal(OUTBOX_ABANDONED_TYPE, "gone-1", {
      v: OUTBOX_ENTRY_VERSION, id: "gone-1", key: "k-gone-1", n: 1, at: t - 90_000,
      mutation: VERB, attempts: OUTBOX_MAX_SERVER_FAILURES,
      lastError: { message: "internal error", code: "internal", status: 500 },
    });
    seed.close();

    const store = new IndexedDbMirrorStore({ owner: "acct-c10", factory: real });
    const engine = new OhmailEngine({
      adapter: failingAdapter(new FixturesAdapter(), SERVER_500),
      store,
      now: () => new Date(t),
    });

    // THE DRIVE FIRST, deliberately — no hydrate, no start. This is the call that used to latch.
    await engine.syncOnce().catch(() => { /* the drive's own outcome is not what this asserts */ });

    // Now the load the host was always going to do.
    await engine.hydrate();

    expect(
      engine.pendingMutations().map((p) => p.id),
      "the previous session's queued verb was latched away by the early drive",
    ).toEqual(["live-1"]);
    expect(
      engine.abandoned().map((a) => a.id),
      "the previous session's abandoned record was latched away by the early drive",
    ).toEqual(["gone-1"]);
    store.close();
  });
});

describe("the carve-out holds on the phone's store too", () => {
  /**
   * ── ONE RULE, TWO BACKENDS, AND THE SECOND ONE WAS UNCOVERED ───────────────────────────────
   *
   * The 410 carry-through is implemented twice — once in the IndexedDB wipe's transaction, once in
   * the sqlite wipe's batch — because the two stores persist differently. A rule with two
   * implementations needs two tests, and it did not have them: deleting the `keep` re-put from
   * `sql-store.ts` passed all 912 tests in this package, so every queued verb on a phone would be
   * lost on the first expired cursor and nothing would have said so.
   *
   * The sqlite half runs through `SqlExecutor.batch`, which the test's SQL runner implements as a real
   * `BEGIN IMMEDIATE`/`COMMIT` — faking it with sequential runs would make the atomicity claim
   * pass vacuously in the one place it has to be able to fail.
   */
  it("the outbox rides the wipe and a re-derivable body does not — and a reboot over the same database agrees", async () => {
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const world = sqlWorld();
    const store = new SqlMirrorStore({ owner: "origin|acct-carve", open: world.open });
    await store.load();

    await store.putLocal(OUTBOX_TYPE, "live-1", {
      v: OUTBOX_ENTRY_VERSION, id: "live-1", key: "k-live-1", n: 0, at: t, mutation: VERB, attempts: 0,
    });
    await store.putLocal(OUTBOX_ABANDONED_TYPE, "gone-1", {
      v: OUTBOX_ENTRY_VERSION, id: "gone-1", key: "k-gone-1", n: 1, at: t - 1000, mutation: VERB,
      attempts: OUTBOX_MAX_SERVER_FAILURES,
      lastError: { message: "internal error", code: "internal", status: 500 },
    });
    await store.putLocal("message_body", "giulia", { id: "giulia", html: "<p>body</p>" });

    await store.resetForBootstrap();
    expect(store.entries(OUTBOX_TYPE)).toHaveLength(1);
    expect(store.entries(OUTBOX_ABANDONED_TYPE)).toHaveLength(1);
    expect(store.get("message_body", "giulia")).toBeUndefined();
    store.close();

    // A different process over the same database file. Only what the wipe's batch committed exists.
    const store2 = new SqlMirrorStore({ owner: "origin|acct-carve", open: world.open });
    await store2.load();
    expect(store2.entries(OUTBOX_TYPE), "the queued verb did not survive the wipe").toHaveLength(1);
    expect(store2.entries(OUTBOX_ABANDONED_TYPE), "the abandoned record did not survive the wipe").toHaveLength(1);
    expect(store2.get("message_body", "giulia")).toBeUndefined();
    store2.close();
  });
});

describe("I8 — a fresh verb arriving mid-replay takes the same lane", () => {
  /**
   * ── THE ROAD THAT WAS NEVER IN THE LANE ────────────────────────────────────────────────────
   *
   * `retryAbandoned` and `flushPending` went through `outboxGate`. `mutate` and `replayOutbox`
   * did not — they used a private `replayActive` deferred, which serialized them against each
   * other and against nothing else. So a verb expressed while the boot replay was running could
   * be on the wire beside a replayed one.
   *
   * For the read verbs that is the whole contract. Their supersession key is `null`, so nothing
   * retires them and nothing orders them but the lane: a newer `unread` landing before an older
   * `read` leaves the server at the older value, and no later drain notices, because both
   * requests succeeded. The mailbox is simply wrong from then on.
   *
   * The adapter here records the order in which requests REACH IT and counts overlap, because
   * "serialized" is a claim about the wire and not about the promise the caller holds.
   */
  it("a mutate issued mid-replay reaches the wire AFTER the replayed verb, and never beside it", async () => {
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const real = new IDBFactory();

    // A warm mirror first: the fresh verb below needs a real target, and a store holding only
    // an outbox row has no messages until a drain runs — which is the very thing this test
    // stalls. A cold mirror made the fresh verb roll back `not_found` and the ordering
    // assertion passed for the wrong reason.
    const warm = new IndexedDbMirrorStore({ owner: "acct-i8-lane", factory: real });
    const warmer = new OhmailEngine({
      adapter: new FixturesAdapter(), store: warm, now: () => new Date(t),
    });
    await warmer.start();
    warm.close();

    // A verb from a previous session, waiting on disk.
    const seed = new IndexedDbMirrorStore({ owner: "acct-i8-lane", factory: real });
    await seed.load();
    await seed.putLocal(OUTBOX_TYPE, "replayed-1", {
      v: OUTBOX_ENTRY_VERSION, id: "replayed-1", key: "k-replayed-1", n: 0, at: t - 60_000,
      mutation: { kind: "mark_seen", messageIds: ["giulia"], unread: false },
      attempts: 0,
    });
    seed.close();

    const order: string[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    let releaseReplay: (() => void) | null = null;
    const inner = new FixturesAdapter();
    const store = new IndexedDbMirrorStore({ owner: "acct-i8-lane", factory: real });
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => inner.sync(...a),
        mutate: async (m: EngineMutation, o: { idempotencyKey: string }) => {
          inFlight += 1;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          order.push(o.idempotencyKey === "k-replayed-1" ? "replayed" : "fresh");
          // Hold the REPLAYED request open, so a fresh verb expressed now has every chance to
          // overtake it. Before the gate covered this road, it did.
          if (o.idempotencyKey === "k-replayed-1") {
            await new Promise<void>((r) => { releaseReplay = r; });
          }
          inFlight -= 1;
          return { changes: [], seq: 1 };
        },
      } as never,
      store,
      now: () => new Date(t),
    });
    await engine.hydrate();
    expect(engine.pendingMutations()).toHaveLength(1);

    const macrotick = () => new Promise<void>((r) => { setTimeout(r, 1); });
    const drive = engine.syncOnce();
    for (let i = 0; i < 50 && releaseReplay === null; i++) await macrotick();
    expect(releaseReplay, "the replayed verb never reached the wire").not.toBeNull();

    // The fresh verb, expressed while the replayed request is still open.
    const fresh = engine.mutate({
      kind: "mark_seen", messageIds: ["giulia"], unread: true,
    } as EngineMutation);
    for (let i = 0; i < 20; i++) await macrotick();

    // IT HAS NOT REACHED THE WIRE. Not queued-and-forgotten, not refused — waiting its turn.
    expect(order, "the fresh verb overtook the replayed one").toEqual(["replayed"]);

    releaseReplay!();
    const fr = await fresh;
    expect(fr.status, "the fresh verb must reach the wire, not roll back").not.toBe("rolled_back");
    await drive;
    for (let i = 0; i < 20; i++) await macrotick();

    expect(order).toEqual(["replayed", "fresh"]);
    expect(maxConcurrent, "two outbox requests were open at once").toBe(1);
    store.close();
  });
});

describe("a durable commit and a re-bootstrap never interleave", () => {
  /**
   * ── THE ROUND-FOUR CRITICAL, AND WHY THIS TEST LOOKS LIKE THIS ─────────────────────────────
   *
   * A reset decides which rows survive by reading `records`. A commit does not appear in
   * `records` until its transaction has already committed to disk — that is write-then-publish.
   * Overlap them and the wipe can clear a row the commit already wrote, while `putOutbox` has
   * answered success and the verb has gone to the server. A kill then leaves the next boot with
   * no key, and the next press mints a fresh one: a second message nobody can take back.
   *
   * THE FIRST VERSION OF THIS TEST JUST CALLED BOTH AND HOPED. It passed with the lane removed,
   * because the dangerous interleaving is about one microtask wide and the run happened to get
   * the safe order — the wipe's transaction landed before the commit's. A guard that depends on
   * which of two transactions the backend happens to schedule first is not a guard; it is a coin
   * that will land heads in CI for months and then stop.
   *
   * So the timing is HELD rather than hoped for. `SqlExecutor.batch` is a seam the test owns
   * completely, so the commit's write can be suspended for as long as the assertion needs, and
   * the question becomes a plain one with a definite answer: while a durable commit is in flight,
   * has the reset taken effect? Under the lane it cannot have. Without it, it already has.
   */

  /**
   * ── THE ROUND-FOUR CRITICAL ────────────────────────────────────────────────────────────────
   *
   * A reset decides which rows survive by reading `records`. A commit does not appear in
   * `records` until its transaction has already committed to disk — that is the whole point of
   * write-then-publish. Those two facts contradict each other the moment they overlap:
   *
   *   the send's transaction opens · the reset snapshots `records` and does not see it · the
   *   send's transaction commits and publishes · the wipe runs with the stale snapshot and
   *   re-puts only what it saw.
   *
   * The row is then in memory and NOT on disk, while `putOutbox` has already answered success and
   * the send has gone to the server. A kill before the answer leaves the next boot with no key,
   * and the next press mints a fresh one — a second message nobody can take back.
   *
   * No fault injection here: the interleaving is ordinary async ordering. `resetForBootstrap`
   * reads `records` before its first await, so starting it while a commit is suspended is enough.
   * That is worth saying plainly — the window is not exotic, it is the default.
   */
  it("a commit that lands during a re-bootstrap is on disk for the next process", async () => {
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const real = new IDBFactory();
    const store = new IndexedDbMirrorStore({ owner: "acct-race", factory: real });
    await store.load();

    // Something for the wipe to actually clear, so the reset is doing its real job.
    await store.putLocal(OUTBOX_TYPE, "older-1", {
      v: OUTBOX_ENTRY_VERSION, id: "older-1", key: "k-older-1", n: 0, at: t - 1000,
      mutation: VERB, attempts: 0,
    });

    // THE RACE, started deliberately: the commit is in flight and has published nothing.
    const commit = store.commitLocal([{
      type: OUTBOX_TYPE,
      id: "inflight-1",
      entity: {
        v: OUTBOX_ENTRY_VERSION, id: "inflight-1", key: "k-inflight-1", n: 1, at: t,
        mutation: VERB, attempts: 0,
      },
    }], []);
    const reset = store.resetForBootstrap();
    await Promise.all([commit, reset]);

    // Memory is not the claim — disk is. A fresh process over the same database is the only
    // thing that can tell the difference, which is why the earlier reset tests could not.
    store.close();
    const store2 = new IndexedDbMirrorStore({ owner: "acct-race", factory: real });
    await store2.load();
    const ids = store2.entries<{ key: string }>(OUTBOX_TYPE).map((r) => r.id).sort();
    expect(
      ids,
      "the in-flight commit was erased by the wipe's stale snapshot — its key is gone and the "
        + "verb it belonged to can be delivered a second time",
    ).toContain("inflight-1");
    expect(ids).toContain("older-1");
    store2.close();
  });

  it("the ordering holds the other way round too — a commit issued during a reset lands after it", async () => {
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const real = new IDBFactory();
    const store = new IndexedDbMirrorStore({ owner: "acct-race-2", factory: real });
    await store.load();

    const reset = store.resetForBootstrap();
    const commit = store.commitLocal([{
      type: OUTBOX_TYPE,
      id: "after-1",
      entity: {
        v: OUTBOX_ENTRY_VERSION, id: "after-1", key: "k-after-1", n: 0, at: t,
        mutation: VERB, attempts: 0,
      },
    }], []);
    await Promise.all([reset, commit]);
    store.close();

    // The wipe bumps the generation; a commit that queued behind it must write against the NEW
    // baseline rather than being fenced off it. If the lane were wrong in this direction the row
    // would be refused rather than erased — quieter, and just as lost.
    const store2 = new IndexedDbMirrorStore({ owner: "acct-race-2", factory: real });
    await store2.load();
    expect(
      store2.entries(OUTBOX_TYPE).map((r) => r.id),
      "a commit that queued behind the reset was fenced off the new baseline",
    ).toEqual(["after-1"]);
    store2.close();
  });
});

describe("there is ONE dispatch, and the source says so", () => {
  it("nothing calls `dispatchWithDeadline` except `dispatchOnLane`", async () => {
    /**
     * ── WHY A CENSUS AND NOT A TEST ────────────────────────────────────────────────────────
     *
     * Round four found the gate global and two of the rules riding on it not: `retryAbandoned`
     * and `flushPendingInner` had neither the release-time hold check nor `deferReconcile`,
     * because both were added to `mutate` by hand and never carried across. Every behavioural
     * test passed. They would: each road works perfectly well on its own, and what was missing
     * only shows when a hold is armed at one particular moment or a drain is slow.
     *
     * "Add it to the other three" fixes today and not tomorrow — the fourth road someone adds
     * next month starts the count again. So the rules live in one method and this asserts there
     * is no way to dispatch around it. That is the difference between a fix and an invariant.
     */
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8").split("\n");

    const calls = src
      .map((text, i) => ({ line: i + 1, text: text.trim() }))
      .filter((x) => /\.dispatchWithDeadline\(/.test(x.text) || /\bdispatchWithDeadline\(/.test(x.text))
      .filter((x) => !/private async dispatchWithDeadline\(/.test(x.text))
      .filter((x) => !x.text.startsWith("*") && !x.text.startsWith("//"));

    expect(
      calls.length,
      "exactly one call is expected — the one inside `dispatchOnLane`. Another means a road that "
        + "skips the release-time hold check, or runs its reconcile while holding the lane, or "
        + "both — which is precisely what round four found",
    ).toBe(1);

    /**
     * ── AND IT CARRIES BOTH RULES, WHICH THE COUNT ALONE DOES NOT CHECK ────────────────────
     *
     * Round five's LOW: deleting `deferReconcile: true` from that one call reopened the defect
     * and nothing went red. The census counted call SITES; the rules the site is supposed to
     * carry were not in it. A guard that pins where a thing is written and not what it says is
     * half a guard.
     */
    const laneBody = src.slice(
      src.findIndex((l) => /private async dispatchOnLane\(/.test(l)),
      src.findIndex((l) => /private settleReconcile\(/.test(l)),
    ).join("\n");
    expect(
      laneBody,
      "the lane's dispatch no longer defers its reconcile — the deadline then times the DRAIN "
        + "rather than the dispatch, and a completed request can be reported as queued",
    ).toContain("deferReconcile: true");
    expect(
      laneBody,
      "the lane no longer checks the hold at release — a caller queued behind a dispatch that "
        + "times out is let straight through behind its still-open request",
    ).toMatch(/this\.outboxHold/);

    // …and it is the one inside `dispatchOnLane`, not merely the only one somewhere.
    const laneAt = src.findIndex((l) => /private async dispatchOnLane\(/.test(l));
    const deadlineAt = src.findIndex((l) => /private async dispatchWithDeadline\(/.test(l));
    expect(laneAt, "`dispatchOnLane` must exist").toBeGreaterThan(-1);
    expect(
      calls[0]!.line,
      "the single call must sit inside `dispatchOnLane`, above `dispatchWithDeadline`'s own body",
    ).toBeGreaterThan(laneAt);
    expect(calls[0]!.line).toBeLessThan(deadlineAt + 1);
  });

  it("every road reaches the wire through the lane", async () => {
    // The companion to the count: the five roads must actually call it. A census that only
    // forbids the wrong call would stay green if a road stopped dispatching altogether.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8");
    const callers = [...src.matchAll(/this\.dispatchOnLane\(/g)];
    expect(
      callers.length,
      "six roads dispatch: a fresh verb, the boot replay, a retry, a queued verb's Try again, a flush, and the "
        + "hung change a Try again ended (`dispatchEndedFirst`), which goes ahead of the press",
    ).toBe(6);
  });
});

describe("a retry released behind a timed-out dispatch does not join it on the wire", () => {
  it("the retry stays off the wire until the barrier's own request settles", async () => {
    /**
     * ── ROUND FOUR, FINDING 2 ──────────────────────────────────────────────────────────────
     *
     * `retryAbandoned` took the lane but had no RELEASE-TIME hold check. The sequence:
     *
     *   retry A enters the lane · retry B joins behind it · A crosses its deadline, leaving a
     *   request still on the wire, and arms the barrier · the chain releases B · B dispatches
     *   immediately, beside A.
     *
     * If B lands first and A commits afterwards, the older value wins and both requests report
     * success. Checking the hold on ENTRY cannot catch this: when B joined, A had not timed out
     * yet and there was no hold to see. The check has to happen where B is released.
     */
    let t = Date.parse("2026-09-05T09:00:00.000Z");
    const factory = new IDBFactory();
    const store = new IndexedDbMirrorStore({ owner: "acct-r4f2", factory });
    const onWire: string[] = [];
    let failing = true;
    let releaseA!: () => void;
    const inner = new FixturesAdapter();
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => inner.sync(...a),
        mutate: async (_m: EngineMutation, o: { idempotencyKey: string }) => {
          if (failing) throw SERVER_500();
          onWire.push(o.idempotencyKey);
          // The FIRST retry's request never answers — that is what makes it a barrier rather
          // than merely a slow call.
          await new Promise<void>((r) => { releaseA = r; });
          return { changes: [], seq: 1 };
        },
      } as never,
      store,
      now: () => new Date(t),
      outboxReplayDeadlineMs: 40,
    } as never);
    await engine.start();

    // Two records, abandoned the ordinary way.
    for (const id of ["petra", "giulia"]) {
      await engine.mutate({ kind: "triage_set", messageId: id, state: "reply_later" } as EngineMutation);
      for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES * 2; i++) {
        t += OUTBOX_BACKOFF_CAP_MS + 1;
        await engine.syncOnce();
      }
    }
    expect(engine.abandoned()).toHaveLength(2);
    failing = false;

    const [a, b] = engine.abandoned();
    const pa = engine.retryAbandoned(a!.id);
    const pb = engine.retryAbandoned(b!.id);   // joins the lane behind A, before any hold exists

    const macrotick = () => new Promise<void>((r) => { setTimeout(r, 5); });
    // Past A's deadline, so the barrier is armed and B has been released by the chain.
    for (let i = 0; i < 40 && onWire.length === 0; i++) await macrotick();
    for (let i = 0; i < 40; i++) await macrotick();

    expect(
      onWire,
      "the second retry went to the wire while the first request was still open — if it lands "
        + "first and the older one commits after it, the older value wins and both succeed",
    ).toHaveLength(1);

    // B ANSWERED rather than hanging, and its verb is not lost — it is a live queued verb now.
    // `retryAbandoned` moves the record to the live collection before it dispatches, so a press
    // that is then held leaves the verb queued rather than abandoned; the drive after the barrier
    // settles delivers it under the same key.
    const rb = await pb;
    expect(rb.status).toBe("queued");
    expect(
      engine.pendingMutations().some((x) => x.id === b!.id),
      "the held retry lost its verb: it is neither on the wire, nor queued, nor abandoned",
    ).toBe(true);

    releaseA();
    await pa;
    store.close();
  });
});

describe("supersession retires the stale row in the newer verb's own transaction", () => {
  /**
   * ── ROUND FOUR, FINDING 5 ────────────────────────────────────────────────────────────────
   *
   * Supersession used to retire the older queued row with `dropOutbox`, a memory-first delete
   * whose failure is swallowed. Memory drops the older verb, the newer verb goes on the wire, the
   * purge fails, the newer row's write fails too, the process dies — and disk holds only the
   * stale verb, which the next boot replays over the state the newer one established.
   *
   * The carve-out that lets `dropOutbox` stay on the older path was argued for a LONE TERMINAL
   * delete, where memory-first fails safe: gone from memory, still on disk, replayed under the
   * same key. Supersession's delete is one half of a replacement, so that direction is the wrong
   * one. It now rides the newer verb's own transaction.
   *
   * ── WHAT ATOMICITY ALONE DID NOT CLOSE, AND WHAT DID ────────────────────────────────────
   *
   * Atomicity removes the half-applied outcome — older row purged, newer one not written, both
   * intents gone. It does NOT by itself stop a wholly refused transaction from keeping the stale
   * row while the newer verb goes to the wire anyway, so a kill could still replay the stale verb
   * over newer state. That was measured here rather than argued, and it is closed by the rule in
   * `engine.ts`'s header instead: NO WRITE, NO WIRE. A replacement whose transaction was refused
   * is not dispatched at all, and everything the supersession changed goes back — see the
   * no-write-no-wire tests below. The two tests here hold the storage half of that.
   */

  it("a refused write is all-or-nothing: never the half-applied state that loses both intents", async () => {
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const faulty = faultyFactory(new IDBFactory());
    const store = new IndexedDbMirrorStore({ owner: "acct-r4f5", factory: faulty.factory });
    const engine = new OhmailEngine({
      adapter: failingAdapter(new FixturesAdapter(), SERVER_500),
      store,
      now: () => new Date(t),
    });
    await engine.start();

    // An older verb, durably queued.
    await engine.mutate({ kind: "triage_set", messageId: "giulia", state: "reply_later" } as EngineMutation);
    const before = rows(store, OUTBOX_TYPE).map((r) => r.id);
    expect(before).toHaveLength(1);

    // ONLY THE DELETE FAILS. This is the interleaving that separates the two implementations,
    // and the reason the first version of this test could not: when the whole write is refused
    // both shapes leave one row, and when nothing is refused both leave one row. The difference
    // lives in the partial failure — put lands, delete does not.
    faulty.arm({ mode: "none", onWrite: (op, key) =>
      (op === "delete" && key.startsWith("outbox_entry:") ? "abort" : "pass") });
    await engine.mutate({ kind: "triage_set", messageId: "giulia", state: "set_aside" } as EngineMutation);
    expect(faulty.log.broken, "the injected storage fault never fired").toBeGreaterThan(0);

    store.close();
    faulty.heal();

    // ALL OR NOTHING. The refused transaction changed nothing: the older row stands exactly as it
    // was. What must never happen is the half-applied outcome — the older row purged and the
    // newer one not written — which loses both intents and is what a separate best-effort delete
    // produces. (That the surviving row is the stale one is the residual named above.)
    const store2 = new IndexedDbMirrorStore({ owner: "acct-r4f5", factory: faulty.factory });
    await store2.load();
    const after = store2.entries<{ mutation: { state?: string } }>(OUTBOX_TYPE);
    // NEVER BOTH. A separate best-effort delete leaves the newer row written and the older one
    // still there, so the next boot replays the stale verb over the newer state — with the newer
    // verb's own row sitting beside it as evidence that the client knew better. One transaction
    // cannot produce that: the refused delete takes the put down with it.
    expect(
      after.map((r) => r.entity.mutation.state).sort(),
      "disk holds the superseded verb AND its replacement — the stale one will replay",
    ).toEqual(["reply_later"]);
    store2.close();
  });

  it("when the write LANDS, the stale row is gone in the same breath", async () => {
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const factory = new IDBFactory();
    const store = new IndexedDbMirrorStore({ owner: "acct-r4f5b", factory });
    const engine = new OhmailEngine({
      adapter: failingAdapter(new FixturesAdapter(), SERVER_500),
      store,
      now: () => new Date(t),
    });
    await engine.start();

    await engine.mutate({ kind: "triage_set", messageId: "giulia", state: "reply_later" } as EngineMutation);
    await engine.mutate({ kind: "triage_set", messageId: "giulia", state: "set_aside" } as EngineMutation);
    store.close();

    const store2 = new IndexedDbMirrorStore({ owner: "acct-r4f5b", factory });
    await store2.load();
    const after = store2.entries<{ mutation: { state?: string } }>(OUTBOX_TYPE);
    expect(after, "the superseded row is still on disk and will replay over the newer state")
      .toHaveLength(1);
    expect(after[0]!.entity.mutation.state).toBe("set_aside");
    store2.close();
  });
});

describe("no write, no wire — the supersession half", () => {
  it("a replacement whose durable write is refused never reaches the server", async () => {
    /**
     * The rule stated in `engine.ts`'s header, and the same one the send obeys. A verb that
     * replaces queued verbs and could not be written must not be sent: the refused transaction
     * retired nothing, so the verbs it supersedes are still on disk and still the truth. Sending
     * it would put a change on the wire this device has no record of, over intents it has not
     * withdrawn — and a kill would replay those older verbs on top of it.
     */
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const faulty = faultyFactory(new IDBFactory());
    const store = new IndexedDbMirrorStore({ owner: "acct-nwnw", factory: faulty.factory });
    const calls: string[] = [];
    const inner = new FixturesAdapter();
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => inner.sync(...a),
        mutate: async (m: EngineMutation) => {
          calls.push((m as { state?: string }).state ?? m.kind);
          throw SERVER_500();
        },
      } as never,
      store,
      now: () => new Date(t),
    });
    await engine.start();

    // The older verb, durably queued and still waiting.
    await engine.mutate({ kind: "triage_set", messageId: "giulia", state: "reply_later" } as EngineMutation);
    expect(calls).toEqual(["reply_later"]);
    expect(engine.pendingMutations()).toHaveLength(1);

    // Storage refuses. The newer verb replaces the older one.
    faulty.arm({ mode: "none", onWrite: (_op, key) => (key.startsWith("outbox_entry:") ? "quota" : "pass") });
    const res = await engine.mutate({ kind: "triage_set", messageId: "giulia", state: "set_aside" } as EngineMutation);

    expect(faulty.log.broken, "the injected storage fault never fired").toBeGreaterThan(0);
    // NOT ON THE WIRE.
    expect(calls, "the replacement was sent although this device holds no record of it")
      .toEqual(["reply_later"]);
    // REFUSED TO THE PERSON, with a reason.
    expect(res.status).toBe("rolled_back");
    expect(res.error?.code).toBe("storage_refused");
    // AND THE OLDER VERB IS STILL THE TRUTH — in memory as well as on disk, so the two do not
    // disagree for the rest of the session.
    expect(
      engine.pendingMutations().map((p) => (p.mutation as { state?: string }).state),
      "the superseded verb was dropped from the queue even though its replacement never happened",
    ).toEqual(["reply_later"]);
    expect(rows(store, OUTBOX_TYPE)).toHaveLength(1);
    store.close();
  });
});

describe("a refusal the store would not take still disables the control", () => {
  const seedAbandoned = async (store: IndexedDbMirrorStore, id: string, t: number, m: EngineMutation) =>
    store.putLocal(OUTBOX_ABANDONED_TYPE, id, {
      v: OUTBOX_ENTRY_VERSION, id, key: `k-${id}`, n: 1, at: t - 90_000, mutation: m,
      attempts: OUTBOX_MAX_SERVER_FAILURES,
      lastError: { message: "internal error", code: "internal", status: 500 },
    });

  it("a refused retry whose durable marker cannot be written is not offered again this session", async () => {
    /**
     * ── ROUND FOUR, FINDING 7 ──────────────────────────────────────────────────────────────
     *
     * The marker's `catch` said "the in-memory refusal below still stands for this session" and
     * there was no such thing. `abandoned()` derives from the store's version; a refused commit
     * changes neither the record nor the version, so the next read returned the same cached row
     * with Retry enabled. Every press was another silent no-op — which the code beside it calls
     * worse than no button. The comment was a claim, and the claim was false.
     *
     * An EXPIRED CREATE, deliberately: a superseded record's `retryable` is already false through
     * its own flag, so the earlier refusal tests passed with the persistence deleted. Only a
     * record whose refusal has no other source can isolate this.
     */
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const faulty = faultyFactory(new IDBFactory());
    const store = new IndexedDbMirrorStore({ owner: "acct-r4f7", factory: faulty.factory });
    await store.load();
    // A create old enough that replaying it would mint a duplicate — refused for that reason.
    await seedAbandoned(store, "old-create", t, {
      kind: "draft_save", draftId: null, mailboxId: "mbx-1",
      subject: "s", body: "b", to: [], cc: [], bcc: [],
    } as unknown as EngineMutation);
    store.close();

    const store2 = new IndexedDbMirrorStore({ owner: "acct-r4f7", factory: faulty.factory });
    const engine = new OhmailEngine({
      adapter: new FixturesAdapter(), store: store2,
      now: () => new Date(t + 40 * 24 * 60 * 60 * 1000),
    });
    await engine.hydrate();
    expect(engine.abandoned()).toHaveLength(1);
    expect(engine.abandoned()[0]?.retryable).toBe(true);

    // Storage refuses the marker the refusal wants to write.
    faulty.arm({ mode: "none", onWrite: (_op, key) => (key.startsWith("outbox_abandoned:") ? "quota" : "pass") });
    const res = await engine.retryAbandoned("old-create");
    expect(res.status).toBe("rolled_back");
    expect(res.error?.code).toBe("outbox_expired");
    expect(faulty.log.broken, "the injected storage fault never fired").toBeGreaterThan(0);

    // THE POINT: the control is gone even though the store would not record why.
    const after = engine.abandoned();
    expect(after).toHaveLength(1);
    expect(
      after[0]?.retryable,
      "the press was refused and the control is still offering itself — the next press is another "
        + "silent no-op",
    ).toBe(false);
    expect(after[0]?.refusedCode).toBe("outbox_expired");
    store2.close();
  });

  it("an unknown verb kind at the CURRENT version refuses instead of crashing", async () => {
    /**
     * ── ROUND FOUR, FINDING 8 ──────────────────────────────────────────────────────────────
     *
     * The persisted-shape gate accepts any string as a kind, deliberately, so a row written by a
     * NEWER build survives instead of being discarded. `mutationEffects` has no runtime default,
     * so it answers `undefined` and the caller reads `.length` off it. The suite only protected
     * unknown VERSIONS; this is a known version carrying a verb this build has never heard of.
     */
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const factory = new IDBFactory();
    const seed = new IndexedDbMirrorStore({ owner: "acct-r4f8", factory });
    await seed.load();
    await seedAbandoned(seed, "future-verb", t, { kind: "teleport_message", messageId: "giulia" } as unknown as EngineMutation);
    seed.close();

    const store = new IndexedDbMirrorStore({ owner: "acct-r4f8", factory });
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), store, now: () => new Date(t) });
    await engine.hydrate();
    expect(engine.abandoned()).toHaveLength(1);

    const res = await engine.retryAbandoned("future-verb");
    expect(res.status).toBe("rolled_back");
    expect(
      res.error?.code,
      "an unknown verb crashed rather than saying it cannot be retried",
    ).toBe("outbox_unknown_kind");
    expect(engine.abandoned()[0]?.retryable).toBe(false);
    store.close();
  });
});

describe("a terminal outcome the store refuses does not hide the verb until restart", () => {
  it("the record stays listed and operable when its transition cannot be written", async () => {
    /**
     * ── ROUND FOUR, FINDING 6 ──────────────────────────────────────────────────────────────
     *
     * A verb restored from a previous session is dispatched by the boot replay, which takes it
     * out of the queue first. When the server refuses it terminally, the record moves from the
     * live collection to the abandoned one — and if THAT write fails, nothing moved on disk while
     * the queue has already let go. The verb is then in the queue, in the abandoned list and on
     * the screen exactly nowhere, with its durable row sitting there unreferenced, and the boot
     * latch stops the store being read again this session.
     *
     * The person who most needs to see this is the one whose send came back "this may have gone,
     * check Sent": the warning appears and there is nothing left to act on.
     */
    const t = Date.parse("2026-09-05T09:00:00.000Z");
    const real = new IDBFactory();
    const seed = new IndexedDbMirrorStore({ owner: "acct-r4f6", factory: real });
    await seed.load();
    await seed.putLocal(OUTBOX_TYPE, "restored-1", {
      v: OUTBOX_ENTRY_VERSION, id: "restored-1", key: "k-restored-1", n: 0, at: t - 60_000,
      mutation: VERB, attempts: 0,
    });
    seed.close();

    const faulty = faultyFactory(real);
    const store = new IndexedDbMirrorStore({ owner: "acct-r4f6", factory: faulty.factory });
    const engine = new OhmailEngine({
      adapter: failingAdapter(new FixturesAdapter(), () => new MutationRejectedError(
        "that conversation is no longer in your mailbox",
        { status: 404, code: "not_found", retryable: false },
      )),
      store,
      now: () => new Date(t),
    });
    await engine.hydrate();
    expect(engine.pendingMutations()).toHaveLength(1);

    // The transition's own write is refused — the abandoned row cannot be created.
    faulty.arm({ mode: "none", onWrite: (_op, key) => (key.startsWith("outbox_abandoned:") ? "quota" : "pass") });
    await engine.syncOnce();
    expect(faulty.log.broken, "the injected storage fault never fired").toBeGreaterThan(0);

    // THE VERB IS STILL SOMEWHERE A PERSON CAN SEE AND ACT ON IT.
    const listed = engine.abandoned();
    expect(
      listed,
      "the verb is in no collection at all: the queue let go, the store refused the record, and "
        + "the boot latch will not read disk again this session",
    ).toHaveLength(1);
    expect(listed[0]?.id).toBe("restored-1");
    expect(listed[0]?.error.message).toBe("that conversation is no longer in your mailbox");

    // And the truth on disk is unchanged — the row is still live, so a reboot replays it.
    expect(rows(store, OUTBOX_TYPE)).toHaveLength(1);
    expect(rows(store, OUTBOX_ABANDONED_TYPE)).toHaveLength(0);
    store.close();
  });
});

describe("the abandoned target policy, one fixture per behaviour", () => {
  /**
   * ── ROUND FOUR, FINDING 4 ──────────────────────────────────────────────────────────────────
   *
   * Four separate defects lived in one predicate, and the earlier tests could not tell them apart
   * because they all asked the same question — "was the record marked?" — of fixtures that shared
   * a target. Each case below is chosen so that exactly one behaviour decides it.
   */
  const t = Date.parse("2026-09-05T09:00:00.000Z");

  async function world(owner: string, older: EngineMutation) {
    const factory = new IDBFactory();
    const seed = new IndexedDbMirrorStore({ owner, factory });
    await seed.load();
    await seed.putLocal(OUTBOX_ABANDONED_TYPE, "older-1", {
      v: OUTBOX_ENTRY_VERSION, id: "older-1", key: "k-older-1", n: 0, at: t - 90_000,
      mutation: older, attempts: OUTBOX_MAX_SERVER_FAILURES,
      lastError: { message: "internal error", code: "internal", status: 500 },
    });
    seed.close();
    const store = new IndexedDbMirrorStore({ owner, factory });
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), store, now: () => new Date(t) });
    await engine.start();
    return { store, engine };
  }

  const recordOf = (store: IndexedDbMirrorStore) =>
    store.entries<{ superseded?: boolean; mutation: { messageIds?: string[] } }>(OUTBOX_ABANDONED_TYPE)[0]?.entity;

  it("a PARTIAL read overlap narrows the record rather than leaving it whole", async () => {
    // The record owes a read on giulia AND petra. A newer verb names giulia alone. Leaving the
    // record untouched means Try again re-reads giulia — undoing what the person just did — while
    // retiring it drops the petra half nothing else will deliver. Neither; it narrows.
    const { store, engine } = await world("acct-p4-narrow", {
      kind: "mark_seen", messageIds: ["giulia", "petra"], unread: false,
    } as EngineMutation);
    await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: true } as EngineMutation);

    const rec = recordOf(store);
    expect(rec?.superseded, "the whole record was retired — the petra half is lost").not.toBe(true);
    expect(
      rec?.mutation.messageIds,
      "the record still names giulia: pressing Try again re-reads a message the person has just "
        + "marked unread",
    ).toEqual(["petra"]);
    store.close();
  });

  it("a newer verb of a DIFFERENT kind on the same message leaves an independent intent alone", async () => {
    // A tag assignment and a triage are two different things a person wanted. Sharing a message
    // is not a reason to throw one away — and the loss is invisible, because a retired record
    // simply stops offering itself.
    const { store, engine } = await world("acct-p4-cross", {
      kind: "tag_assign", messageId: "giulia", tagId: "tag-a", assigned: true,
    } as unknown as EngineMutation);
    await engine.mutate({ kind: "triage_set", messageId: "giulia", state: "reply_later" } as EngineMutation);

    expect(
      recordOf(store)?.superseded,
      "a triage retired a queued tag assignment on the same message — two intents, one thrown away",
    ).not.toBe(true);
    store.close();
  });

  it("assigning a SECOND tag to the same message does not retire the first", async () => {
    // Both verbs are `tag_assign` and both name the message, so a predicate keyed on the message
    // alone retires the first — losing tag A the moment tag B is applied. The verb owns its tag.
    const { store, engine } = await world("acct-p4-tag", {
      kind: "tag_assign", messageId: "giulia", tagId: "tag-a", assigned: true,
    } as unknown as EngineMutation);
    await engine.mutate({
      kind: "tag_assign", messageId: "giulia", tagId: "tag-b", assigned: true,
    } as unknown as EngineMutation);

    expect(
      recordOf(store)?.superseded,
      "applying a second tag retired the first tag's record — the first tag is silently dropped",
    ).not.toBe(true);
    store.close();
  });

  it("a newer DESTRUCTION retires an older verb on the thing it destroys", async () => {
    /**
     * The other direction of the destructive rule, and it is a different branch from "an older
     * destruction is retired by a newer intent": here the destruction is the NEWER verb. Once the
     * message is gone, replaying a tag assignment on it can only fail or resurrect it.
     *
     * The verb is a message delete rather than a tag delete because the fixture world holds this
     * message and does not hold an arbitrary tag — and a verb naming an id the fixtures lack is
     * refused before supersession ever runs, so that pair would test the fixture and nothing else.
     * The existing target table beside this covers the tag-id half of ownership directly.
     */
    // A REAL tag, read out of the fixture world rather than invented: a verb naming an id the
    // fixtures lack is refused before supersession runs, so an invented one would test the
    // fixture. This is what makes the tag half of ownership load-bearing — without it the record
    // and the deletion share no target at all and nothing retires it.
    const probe = new IndexedDbMirrorStore({ owner: "acct-p4-probe", factory: new IDBFactory() });
    const probeEngine = new OhmailEngine({
      adapter: new FixturesAdapter(), store: probe, now: () => new Date(t),
    });
    await probeEngine.start();
    const tagId = probeEngine.read().list<{ id: string }>("tag")[0]?.id;
    probe.close();
    expect(tagId, "the fixture world holds no tags — this case cannot be built").toBeDefined();

    const { store, engine } = await world("acct-p4-destroy", {
      kind: "tag_assign", messageId: "giulia", tagId, assigned: true,
    } as unknown as EngineMutation);
    await engine.mutate({ kind: "tag_delete", tagId } as unknown as EngineMutation);

    expect(
      recordOf(store)?.superseded,
      "the record still wants to apply a tag that has since been deleted — the verb owns the tag "
        + "as well as the message, and only the tag connects these two",
    ).toBe(true);
    store.close();
  });

  it("the marker is written BEFORE the newer verb reaches the wire", async () => {
    /**
     * The window: between marking a record stale and the verb going out, another tab — or a fast
     * second press — can retry that record. `supersedeAbandoned` awaits its own writes, and its
     * caller then discarded the promise, which put the window straight back.
     *
     * THE TIMING IS HELD, because ordinary async ordering does not decide this. The write the
     * verb makes for itself involves several awaits, so a discarded marker promise usually
     * finishes first anyway and the test would pass for a reason unrelated to the fix.
     *
     * ── TWO ENFORCERS, AND THIS TEST MEASURED THAT RATHER THAN ASSUMING IT ──────────────────
     *
     * Removing the `await` alone does NOT make this red, and that is worth writing down instead
     * of quietly picking a mutation that works. The store now serializes its durable writes into
     * one lane, so the verb's own record queues behind the marker's whether or not the engine
     * awaits it. The ordering therefore has two independent guarantees: the engine's explicit
     * await, and the store's write lane. Only removing BOTH puts the verb on the wire ahead of
     * the marker — which is what this was watched red against.
     *
     * The await stays, redundant today: it states the engine's own requirement, and it survives a
     * store that does not serialize. A guarantee that exists only as a side effect of somebody
     * else's mechanism is one refactor away from being gone.
     */
    const world2 = sqlWorld();
    let hold: Promise<void> | null = null;
    let release!: () => void;
    const open = (name: string) => {
      const inner = world2.open(name);
      return {
        all: inner.all.bind(inner),
        batch: async (statements: Parameters<typeof inner.batch>[0]) => {
          const touchesRecord = statements.some((st) =>
            (st.params ?? []).some((v) => typeof v === "string" && v.startsWith("outbox_abandoned:")));
          if (hold && touchesRecord) await hold;
          return inner.batch(statements);
        },
        close: inner.close?.bind(inner),
      } as typeof inner;
    };

    const store = new SqlMirrorStore({ owner: "origin|acct-p4-order", open });
    await store.load();
    await store.putLocal(OUTBOX_ABANDONED_TYPE, "older-1", {
      v: OUTBOX_ENTRY_VERSION, id: "older-1", key: "k-older-1", n: 0, at: t - 90_000,
      mutation: { kind: "triage_set", messageId: "giulia", state: "reply_later" },
      attempts: OUTBOX_MAX_SERVER_FAILURES,
      lastError: { message: "internal error", code: "internal", status: 500 },
    });

    const seen: string[] = [];
    const inner = new FixturesAdapter();
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => inner.sync(...a),
        mutate: async (...a: unknown[]) => {
          seen.push("wire");
          return (inner.mutate as never as (...x: unknown[]) => Promise<unknown>)(...a);
        },
      } as never,
      store,
      now: () => new Date(t),
    });
    await engine.start();

    hold = new Promise<void>((r) => { release = r; });
    const verb = engine.mutate({ kind: "triage_set", messageId: "giulia", state: "set_aside" } as EngineMutation);
    for (let i = 0; i < 12; i++) await new Promise<void>((r) => { setTimeout(r, 0); });

    expect(
      seen,
      "the verb reached the wire while the record it supersedes was still retryable — another tab, "
        + "or a second press, can replay a stale intent behind it",
    ).toEqual([]);

    release();
    hold = null;
    await verb;
    expect(seen).toEqual(["wire"]);
    store.close();
  });
});

describe("round five: the four that were mine", () => {
  const t5 = Date.parse("2026-09-05T09:00:00.000Z");

  const seedAb = async (store: IndexedDbMirrorStore, id: string, m: EngineMutation) =>
    store.putLocal(OUTBOX_ABANDONED_TYPE, id, {
      v: OUTBOX_ENTRY_VERSION, id, key: `k-${id}`, n: 0, at: t5 - 90_000, mutation: m,
      attempts: OUTBOX_MAX_SERVER_FAILURES,
      lastError: { message: "internal error", code: "internal", status: 500 },
    });

  it("(2) a glance cannot cancel a deliberate unread that was given up on", async () => {
    /**
     * The queue has always applied the explicit/glance rule; abandoned rows skipped it and were
     * subtracted by ANY newer read verb. So a deliberate `mark_seen(unread: true)` could be
     * narrowed to nothing — and marked superseded, losing its Retry — by a later glance over the
     * same message. The state the person actually asked for was never delivered and the record
     * that remembered it disappeared.
     */
    const factory = new IDBFactory();
    const seed = new IndexedDbMirrorStore({ owner: "acct-r5-glance", factory });
    await seed.load();
    await seedAb(seed, "deliberate-1", {
      kind: "mark_seen", messageIds: ["giulia"], unread: true,
    } as EngineMutation);
    seed.close();

    const store = new IndexedDbMirrorStore({ owner: "acct-r5-glance", factory });
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), store, now: () => new Date(t5) });
    await engine.start();

    // A glance over the same message: involuntary, and it reads rather than unreads.
    await engine.mutate({
      kind: "mark_seen", messageIds: ["giulia"], unread: false, via: "glance",
    } as unknown as EngineMutation);

    const rec = store.entries<{ superseded?: boolean; mutation: { messageIds?: string[] } }>(
      OUTBOX_ABANDONED_TYPE,
    )[0]?.entity;
    expect(rec?.superseded, "a glance retired a deliberate unread").not.toBe(true);
    expect(
      rec?.mutation.messageIds,
      "a glance subtracted the message from a deliberate unread — the intent is gone and so is "
        + "the record that remembered it",
    ).toEqual(["giulia"]);
    store.close();
  });

  it("(4) a narrowed queued row and its replacement land together or not at all", async () => {
    /**
     * The narrowing was a separate best-effort `putOutbox` per row: outside the replacement's
     * transaction, absent from `retired`, and therefore invisible to no-write-no-wire. Two
     * windows followed — the narrowing lands and the replacement does not, so disk keeps only the
     * narrowed intent while memory has been restored; or the narrowing fails and the replacement
     * lands, so disk keeps the FULL stale read and replays it once the replacement is deleted.
     *
     * The fault refuses the outbox writes, so the whole transaction goes down. What must never
     * appear is a disk holding one of the two.
     */
    const factory = new IDBFactory();
    const faulty = faultyFactory(factory);
    const store = new IndexedDbMirrorStore({ owner: "acct-r5-narrow", factory: faulty.factory });
    const engine = new OhmailEngine({
      adapter: failingAdapter(new FixturesAdapter(), SERVER_500),
      store, now: () => new Date(t5),
    });
    await engine.start();

    // An older read over two messages, durably queued.
    await engine.mutate({
      kind: "mark_seen", messageIds: ["giulia", "petra"], unread: false,
    } as EngineMutation);
    const before = rows(store, OUTBOX_TYPE).map((r) => r.id);
    expect(before).toHaveLength(1);

    /**
     * ONLY THE REPLACEMENT'S OWN ROW IS REFUSED — the narrowed older row is let through.
     *
     * Refusing every outbox write cannot tell the two implementations apart: one transaction and
     * two separate writes both end with nothing on disk. The difference lives in the case where
     * the narrowing CAN land and the replacement cannot. In one transaction the refused write
     * takes the narrowing down with it; as separate writes the narrowing sticks, and disk is left
     * owing half an intent that memory has already been restored from.
     */
    const olderKey = `outbox_entry:${before[0]}`;
    faulty.arm({ mode: "none", onWrite: (_op, key) =>
      (key.startsWith("outbox_entry:") && key !== olderKey ? "quota" : "pass") });
    await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: true } as EngineMutation);
    expect(faulty.log.broken, "the injected storage fault never fired").toBeGreaterThan(0);
    store.close();
    faulty.heal();

    const store2 = new IndexedDbMirrorStore({ owner: "acct-r5-narrow", factory });
    await store2.load();
    const after = store2.entries<{ mutation: { messageIds?: string[] } }>(OUTBOX_TYPE);
    expect(after, "the durable set is neither the old pair nor the new pair").toHaveLength(1);
    expect(
      after[0]!.entity.mutation.messageIds,
      "the narrowing landed while its replacement did not — disk now owes only half the intent, "
        + "and memory has been restored to the whole of it",
    ).toEqual(["giulia", "petra"]);
    store2.close();
  });

  it("(5) a marker that cannot be written stops the verb, and puts back the ones that did", async () => {
    /**
     * `supersedeAbandoned` turned every marker rejection into success. `mutate` awaited a promise
     * that could not reject and went on to persist and dispatch — while the record it believed it
     * had marked was still retryable and could later overwrite the state the newer verb was
     * establishing. Both requests report success; the older one wins.
     */
    const factory = new IDBFactory();
    const seed = new IndexedDbMirrorStore({ owner: "acct-r5-marker", factory });
    await seed.load();
    await seedAb(seed, "stale-1", { kind: "triage_set", messageId: "giulia", state: "reply_later" } as EngineMutation);
    seed.close();

    const faulty = faultyFactory(factory);
    const store = new IndexedDbMirrorStore({ owner: "acct-r5-marker", factory: faulty.factory });
    const calls: string[] = [];
    const inner = new FixturesAdapter();
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => inner.sync(...a),
        mutate: async (...a: unknown[]) => {
          calls.push("wire");
          return (inner.mutate as never as (...x: unknown[]) => Promise<unknown>)(...a);
        },
      } as never,
      store, now: () => new Date(t5),
    });
    await engine.start();
    expect(engine.abandoned()).toHaveLength(1);

    // Only the MARKER's write fails. The verb's own row would land perfectly well.
    faulty.arm({ mode: "none", onWrite: (_op, key) => (key.startsWith("outbox_abandoned:") ? "quota" : "pass") });
    const res = await engine.mutate({
      kind: "triage_set", messageId: "giulia", state: "set_aside",
    } as EngineMutation);

    expect(faulty.log.broken, "the injected storage fault never fired").toBeGreaterThan(0);
    expect(
      calls,
      "the verb went to the wire while the record it supersedes is still retryable — that record "
        + "can later overwrite the state this verb just established",
    ).toEqual([]);
    expect(res.status).toBe("rolled_back");
    expect(res.error?.code).toBe("storage_refused");
    // The stale record is untouched and still offers its Retry.
    expect(engine.abandoned()[0]?.retryable).toBe(true);
    store.close();
  });

  it("(6) a session-local record's Retry and Discard actually operate", async () => {
    /**
     * `abandoned()` merged the fallback for DISPLAY while both controls searched the durable
     * collection alone. The record was listed with a Retry that answered "this build cannot retry
     * that" and a Discard that deleted a row which was not there. A control that is shown and
     * inert is worse than one that is hidden: the person presses it and believes it worked.
     */
    const factory = new IDBFactory();
    const seed = new IndexedDbMirrorStore({ owner: "acct-r5-local", factory });
    await seed.load();
    await seed.putLocal(OUTBOX_TYPE, "restored-1", {
      v: OUTBOX_ENTRY_VERSION, id: "restored-1", key: "k-restored-1", n: 0, at: t5 - 60_000,
      mutation: VERB, attempts: 0,
    });
    seed.close();

    const faulty = faultyFactory(factory);
    const store = new IndexedDbMirrorStore({ owner: "acct-r5-local", factory: faulty.factory });
    const engine = new OhmailEngine({
      adapter: failingAdapter(new FixturesAdapter(), () => new MutationRejectedError(
        "that conversation is no longer in your mailbox",
        { status: 404, code: "not_found", retryable: false },
      )),
      store, now: () => new Date(t5),
    });
    await engine.hydrate();
    faulty.arm({ mode: "none", onWrite: (_op, key) => (key.startsWith("outbox_abandoned:") ? "quota" : "pass") });
    await engine.syncOnce();
    faulty.heal();
    expect(engine.abandoned(), "the fallback did not list the record").toHaveLength(1);

    // DISCARD OPERATES: the listing goes.
    await engine.discardAbandoned("restored-1");
    expect(
      engine.abandoned(),
      "Discard did nothing: the record is only in memory and the delete only touched disk",
    ).toHaveLength(0);
    store.close();
  });

  it("(6b) Retry on a session-local record is not answered `outbox_unknown_kind`", async () => {
    const factory = new IDBFactory();
    const seed = new IndexedDbMirrorStore({ owner: "acct-r5-local2", factory });
    await seed.load();
    await seed.putLocal(OUTBOX_TYPE, "restored-2", {
      v: OUTBOX_ENTRY_VERSION, id: "restored-2", key: "k-restored-2", n: 0, at: t5 - 60_000,
      mutation: VERB, attempts: 0,
    });
    seed.close();

    const faulty = faultyFactory(factory);
    const store = new IndexedDbMirrorStore({ owner: "acct-r5-local2", factory: faulty.factory });
    const engine = new OhmailEngine({
      adapter: failingAdapter(new FixturesAdapter(), () => new MutationRejectedError(
        "gone", { status: 404, code: "not_found", retryable: false },
      )),
      store, now: () => new Date(t5),
    });
    await engine.hydrate();
    faulty.arm({ mode: "none", onWrite: (_op, key) => (key.startsWith("outbox_abandoned:") ? "quota" : "pass") });
    await engine.syncOnce();
    faulty.heal();
    expect(engine.abandoned()).toHaveLength(1);

    const res = await engine.retryAbandoned("restored-2");
    expect(
      res.error?.code,
      "Retry could not find the record because it looked only on disk — the person presses a "
        + "control that says this build cannot retry their own change",
    ).not.toBe("outbox_unknown_kind");
    store.close();
  });
});

describe("round five: the late answer, and the terminal delete's race", () => {
  const t6 = Date.parse("2026-09-05T09:00:00.000Z");

  it("(3) a request that outlives its deadline still hands back its answer", async () => {
    /**
     * When a dispatch passes its deadline the caller is told `queued` and the attempt goes on as
     * the barrier. Its eventual result used to be dropped. That is fine for a verb the drive owns
     * and wrong for the two a SURFACE waits on: a send's settlement reaches the composer only
     * through a result `flushPending` returns, and the verb is not on the queue — so no later
     * flush produces one and the composer stays locked after the message has gone. A first
     * `draft_save`'s server id exists in exactly that result; lose it and the next edit makes a
     * second draft.
     */
    const factory = new IDBFactory();
    const store = new IndexedDbMirrorStore({ owner: "acct-r5-late", factory });
    let release!: (v: { changes: never[]; seq: number; entityId: string }) => void;
    const inner = new FixturesAdapter();
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => inner.sync(...a),
        mutate: () => new Promise((r) => { release = r as never; }),
      } as never,
      store,
      now: () => new Date(t6),
      outboxReplayDeadlineMs: 30,
    } as never);
    await engine.start();

    const macrotick = () => new Promise<void>((r) => { setTimeout(r, 5); });
    const res = await engine.mutate({
      kind: "triage_set", messageId: "giulia", state: "reply_later",
    } as EngineMutation);
    expect(res.status, "the dispatch did not time out — the deadline is not being applied").toBe("queued");

    // The request settles AFTER its deadline. Nobody is waiting on that promise any more.
    release({ changes: [] as never[], seq: 7, entityId: "srv-1" });
    for (let i = 0; i < 20; i++) await macrotick();

    const flushed = await engine.flushPending();
    expect(
      flushed.some((r) => r.id === res.id),
      "the late answer was thrown away: nothing will ever produce a result for this verb, so a "
        + "composer waiting on its settlement stays locked and a create loses its server id",
    ).toBe(true);
    store.close();
  });

  it("(8) a terminal delete cannot be undone by a re-bootstrap that snapshots around it", async () => {
    /**
     * `prune`'s persisted half raced the reset in exactly the way `commitLocal` used to: the
     * reset reads which rows to carry, the purge lands, and the wipe writes back a row the purge
     * had just removed. The verb had reached its terminal outcome and comes back on the next boot
     * to be sent a second time.
     *
     * The eviction stays synchronous — three callers read the store on the next line — and only
     * the durable half takes its turn on the lane. Held through `SqlExecutor.batch`, because
     * ordinary async ordering does not decide this reliably.
     */
    const world = sqlWorld();
    let holdWipe: Promise<void> | null = null;
    let release!: () => void;
    // ONLY THE WIPE IS HELD. Holding every batch makes both operations queue and the interleaving
    // never happens; the hazard needs the purge to be able to land while the wipe is in the air.
    const isWipe = (st: { sql: string }) => st.sql.trim() === "DELETE FROM entities";
    const open = (name: string) => {
      const inner = world.open(name);
      return {
        all: inner.all.bind(inner),
        batch: async (statements: Parameters<typeof inner.batch>[0]) => {
          if (holdWipe && statements.some(isWipe)) await holdWipe;
          return inner.batch(statements);
        },
        close: inner.close?.bind(inner),
      } as typeof inner;
    };
    const store = new SqlMirrorStore({ owner: "origin|acct-r5-race", open });
    await store.load();
    await store.putLocal(OUTBOX_TYPE, "done-1", {
      v: OUTBOX_ENTRY_VERSION, id: "done-1", key: "k-done-1", n: 0, at: t6, mutation: VERB, attempts: 0,
    });

    /**
     * THE ORDER THAT COSTS YOU: the reset reads which rows to carry — done-1 among them, because
     * it is still there — and its wipe is then held. The terminal delete lands in that gap. When
     * the wipe finally runs it writes back the row the delete just removed, and the next boot
     * sends a verb that had already reached its terminal outcome.
     */
    const reset = store.resetForBootstrap();
    holdWipe = new Promise<void>((r) => { release = r; });
    for (let i = 0; i < 4; i++) await new Promise<void>((r) => { setTimeout(r, 0); });
    const gone = store.pruneSerialized([{ type: OUTBOX_TYPE, id: "done-1" }]);
    for (let i = 0; i < 6; i++) await new Promise<void>((r) => { setTimeout(r, 0); });
    release();
    holdWipe = null;
    await Promise.all([gone, reset]);
    store.close();

    const store2 = new SqlMirrorStore({ owner: "origin|acct-r5-race", open });
    await store2.load();
    expect(
      store2.entries(OUTBOX_TYPE).map((r) => r.id),
      "the re-bootstrap wrote back a verb that had already reached its terminal outcome — the "
        + "next boot sends it again",
    ).toEqual([]);
    store2.close();
  });
});

describe("round six: one owner, one handoff, and a verb on the wire can be superseded", () => {
  const t7 = Date.parse("2026-09-05T09:00:00.000Z");

  it("(2) a timed-out verb is NOT put back on the queue — its request still owns it", async () => {
    /**
     * The verb is off the queue while its request runs. Answering `queued` by pushing it back
     * gave it two owners: the live request, which will settle or re-queue it, and the queue,
     * which a later flush drains. For a draft create — whose route ignores the idempotency key —
     * that second dispatch is a second draft on the server for one the client already asked for.
     */
    const factory = new IDBFactory();
    const store = new IndexedDbMirrorStore({ owner: "acct-r6-owner", factory });
    let release!: (v: unknown) => void;
    const inner = new FixturesAdapter();
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => inner.sync(...a),
        mutate: () => new Promise((r) => { release = r as never; }),
      } as never,
      store, now: () => new Date(t7), outboxReplayDeadlineMs: 30,
    } as never);
    await engine.start();

    const res = await engine.mutate({
      kind: "triage_set", messageId: "giulia", state: "reply_later",
    } as EngineMutation);
    expect(res.status, "the dispatch did not time out").toBe("queued");
    expect(
      engine.pendingMutations().map((p) => p.id),
      "the verb is on the queue while its request is still running — a flush would send it again",
    ).toEqual([]);
    release({ changes: [], seq: 1 });
    store.close();
  });

  it("(3) a late answer that nobody reads is not thrown away", async () => {
    /**
     * `clear()` discarded every late answer, including ones no surface in that flush was going to
     * read. A settlement could be removed by an unrelated consumer and dropped. Only what is
     * actually handed back is removed now.
     */
    const factory = new IDBFactory();
    const store = new IndexedDbMirrorStore({ owner: "acct-r6-late", factory });
    let release!: (v: unknown) => void;
    const inner = new FixturesAdapter();
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => inner.sync(...a),
        mutate: () => new Promise((r) => { release = r as never; }),
      } as never,
      store, now: () => new Date(t7), outboxReplayDeadlineMs: 30,
    } as never);
    await engine.start();

    const res = await engine.mutate({
      kind: "triage_set", messageId: "giulia", state: "reply_later",
    } as EngineMutation);
    release({ changes: [], seq: 3 });
    for (let i = 0; i < 20; i++) await new Promise<void>((r) => { setTimeout(r, 5); });

    const first = await engine.flushPending();
    expect(first.some((r) => r.id === res.id), "the late answer never reached a flush").toBe(true);
    // Handed over ONCE: taken by id, not cleared wholesale, so a second flush does not repeat it.
    const second = await engine.flushPending();
    expect(
      second.some((r) => r.id === res.id),
      "the same settlement was handed over twice — a surface would act on it again",
    ).toBe(false);
    store.close();
  });

  it("(4) a verb on the wire is superseded rather than replayed over newer state", async () => {
    /**
     * The older verb is in no collection while its request runs, so supersession could not see
     * it. It then failed retryably, rejoined the queue AFTER the newer verb had taken its
     * snapshot, and replayed — putting the older value back over the state the newer one had
     * established, with both requests reporting success.
     */
    const factory = new IDBFactory();
    const store = new IndexedDbMirrorStore({ owner: "acct-r6-inflight", factory });
    const wire: string[] = [];
    let failOlder!: (e: unknown) => void;
    const inner = new FixturesAdapter();
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => inner.sync(...a),
        mutate: async (m: EngineMutation) => {
          const state = (m as { state?: string }).state;
          wire.push(state ?? m.kind);
          if (state === "reply_later") {
            await new Promise((_r, rej) => { failOlder = rej as never; });
          }
          return { changes: [], seq: 1 };
        },
      } as never,
      store, now: () => new Date(t7), outboxReplayDeadlineMs: 25,
    } as never);
    await engine.start();

    // The older verb goes on the wire and hangs past its deadline.
    const older = engine.mutate({
      kind: "triage_set", messageId: "giulia", state: "reply_later",
    } as EngineMutation);
    for (let i = 0; i < 20 && wire.length === 0; i++) await new Promise<void>((r) => { setTimeout(r, 5); });
    expect(wire, "the older verb never reached the wire").toEqual(["reply_later"]);

    // A newer verb for the same target is expressed while the older one is still running.
    engine.mutate({ kind: "triage_set", messageId: "giulia", state: "set_aside" } as EngineMutation)
      .catch(() => { /* it may be held behind the barrier; the assertion is about the older one */ });
    for (let i = 0; i < 10; i++) await new Promise<void>((r) => { setTimeout(r, 5); });

    // The older request now fails retryably. It must NOT rejoin the queue.
    failOlder(new MutationRejectedError("net", { code: "network", retryable: true }));
    await older.catch(() => undefined);
    for (let i = 0; i < 20; i++) await new Promise<void>((r) => { setTimeout(r, 5); });

    expect(
      engine.pendingMutations().some((p) => (p.mutation as { state?: string }).state === "reply_later"),
      "the superseded in-flight verb rejoined the queue — replaying it puts the older state back "
        + "over the newer one, and both requests report success",
    ).toBe(false);
    store.close();
  });
});

describe("round seven: a reversal is never beaten by the move it reversed", () => {
  const t8 = Date.parse("2026-09-07T09:00:00.000Z");
  const tick = (): Promise<void> => new Promise<void>((r) => { setTimeout(r, 5); });

  /**
   * ── THE EMPTY QUEUE IS NOT EVIDENCE ABOUT THE WIRE ──────────────────────────────────────────
   *
   * `supersedeQueued` marks in-flight requests so that a retryable answer DROPS them instead of
   * re-queuing them. That scan sat below `if (this.queue.length === 0) return …`, and the queue is
   * empty in exactly the situation the scan exists for: a verb whose request outran its deadline
   * is owned by that request and is in no other collection.
   *
   * So the very first reversal a person makes — move a message, then move it straight back before
   * the first move has been answered — found an empty queue and returned. The older request came
   * back retryable, rejoined the queue with a server-named backoff, and replayed AFTER the
   * reversal had landed: the mailbox ends at the destination the person had already taken back,
   * and both requests reported success.
   */
  it("(1) the older move does not reach the wire a second time after the reversal", async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbMirrorStore({ owner: "acct-r7-reversal", factory });
    const wire: string[] = [];
    let failFirst!: (e: unknown) => void;
    let held = false;
    let clock = t8;
    const inner = new FixturesAdapter();
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => inner.sync(...a),
        mutate: async (m: EngineMutation) => {
          wire.push(String((m as { folder?: string }).folder ?? m.kind));
          if (!held) {
            held = true;
            await new Promise((_r, rej) => { failFirst = rej as never; });
          }
          return { changes: [], seq: 1 };
        },
      } as never,
      store, now: () => new Date(clock), outboxReplayDeadlineMs: 25,
    } as never);
    await engine.start();
    expect(engine.read().get<EngineMessage>("message", "giulia")?.folder).toBe("INBOX");

    // 1 — Inbox → Reads. Its request hangs past the deadline, so the verb is on the wire and in
    //     NO queue: `pendingMutations()` is the assertion that this is the state under test.
    const older = await engine.mutate({
      kind: "move", messageId: "giulia", folder: "ohmail/News",
    } as EngineMutation);
    expect(older.status, "the first move settled — nothing is on the wire").toBe("queued");
    expect(wire, "the first move never reached the wire").toEqual(["ohmail/News"]);
    expect(
      engine.pendingMutations(),
      "the timed-out verb is on the queue, so this case is not the one the finding is about",
    ).toEqual([]);

    // 2 — and back again, before the first move has been answered.
    await engine.mutate({ kind: "move", messageId: "giulia", folder: "INBOX" } as EngineMutation);

    // 3 — the first request now fails the way a SERVER failure fails: counted, so it re-queues
    //     with a backoff and would replay LATER — after the reversal has gone out. That ordering
    //     is the harm; a bare network failure re-queues with no delay and can still win the race.
    failFirst(SERVER_500());
    for (let i = 0; i < 30; i++) await tick();

    // 4 — the backoff elapses and a retry driver comes past.
    clock += OUTBOX_BACKOFF_CAP_MS + 1;
    await engine.flushPending();
    for (let i = 0; i < 20; i++) await tick();

    expect(
      wire,
      "the older move replayed over the reversal — the message ends in the folder the person had "
        + "already taken it out of, and both requests reported success",
    ).toEqual(["ohmail/News", "INBOX"]);
    expect(
      engine.read().get<EngineMessage>("message", "giulia")?.folder,
      "the newest intent is not what the mailbox holds",
    ).toBe("INBOX");
    store.close();
  });

  /**
   * THE POSITIVE CONTROL. A rule whose every case asserts a drop has no evidence it keeps the
   * verbs it must keep: a scan that marked everything in flight would pass the case above and
   * silently delete an unrelated message's move on its first retryable failure.
   */
  it("(2) an in-flight verb for a DIFFERENT target is left alone and still retries", async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbMirrorStore({ owner: "acct-r7-other", factory });
    const wire: string[] = [];
    let failFirst!: (e: unknown) => void;
    let held = false;
    const inner = new FixturesAdapter();
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => inner.sync(...a),
        mutate: async (m: EngineMutation) => {
          wire.push(`${String((m as { messageId?: string }).messageId)}:${String((m as { folder?: string }).folder)}`);
          if (!held) {
            held = true;
            await new Promise((_r, rej) => { failFirst = rej as never; });
          }
          return { changes: [], seq: 1 };
        },
      } as never,
      store, now: () => new Date(t8), outboxReplayDeadlineMs: 25,
    } as never);
    await engine.start();

    await engine.mutate({ kind: "move", messageId: "giulia", folder: "ohmail/News" } as EngineMutation);
    expect(wire, "the first move never reached the wire").toEqual(["giulia:ohmail/News"]);
    expect(engine.pendingMutations(), "the timed-out verb is on the queue").toEqual([]);

    // A move of ANOTHER message. It shares neither the target nor therefore the supersession key.
    await engine.mutate({ kind: "move", messageId: "petra", folder: "ohmail/News" } as EngineMutation);

    failFirst(new MutationRejectedError("net", { code: "network", retryable: true }));
    for (let i = 0; i < 30; i++) await tick();
    await engine.flushPending();
    for (let i = 0; i < 20; i++) await tick();

    expect(
      wire.filter((w) => w === "giulia:ohmail/News").length,
      "an unrelated message's move was dropped as superseded — the person's move is simply gone",
    ).toBe(2);
    store.close();
  });
});

describe("round eight: a mark made for a replacement that never happened", () => {
  const t9 = Date.parse("2026-09-07T09:00:00.000Z");
  const tick = (): Promise<void> => new Promise<void>((r) => { setTimeout(r, 5); });

  /**
   * ── THE ROAD, WHICH WAS REPORTED AS UN-BUILDABLE AND IS NOT ─────────────────────────────────
   *
   * A newer verb marks the older IN-FLIGHT entry superseded synchronously, before its own durable
   * write. If that write is refused the replacement never happens — and the mark used to stand, so
   * the older request's retryable answer DROPPED a verb nothing had replaced. The move is then gone
   * with nothing on the wire, nothing queued, nothing on disk and no sentence anywhere.
   *
   * The road turns on `retiresAbandoned`'s DESTRUCTIVE asymmetry, and on the two collections being
   * keyed differently. `supersedeQueued` and its wire scan key on `supersedeKey`, which carries the
   * KIND (`move:giulia`), so a queued `message_delete` is NOT retired by a later `move`.
   * `supersedeAbandoned` asks `retiresAbandoned`, which retires an abandoned DESTRUCTION by
   * anything later on its target — so the same pair that the queue leaves alone is a marker write
   * the newer `move` must make. That is what lets the marker write fail while a same-key verb is on
   * the wire, and every step of it is something a person does:
   *
   *  1. `move giulia` is queued (offline, or a server failure), and then `message_delete giulia` is
   *     expressed. Different supersession keys, so the move keeps its place in the queue while the
   *     delete runs; the delete exhausts its retries and becomes an abandoned record, and nothing
   *     has superseded it because the move was expressed BEFORE it. The app is then killed.
   *     Disk holds: a queued `move giulia → ohmail/News` and an unmarked abandoned
   *     `message_delete giulia`. That is what this fixture seeds.
   *  2. the boot replay dispatches the queued move — `replayOutboxInner` goes straight to
   *     `dispatchOnLane` and never calls `supersedeAbandoned`, which is why the abandoned record is
   *     still unmarked while the move is on the wire. The move outruns its deadline, so it is owned
   *     by its request and the queue is EMPTY;
   *  3. `move giulia → INBOX` is expressed. Its wire scan marks the move on the wire; its marker
   *     write for the abandoned record is refused, so `mutate` rolls the whole verb back and never
   *     dispatches;
   *  4. the move on the wire answers retryably.
   *
   * The person moved a message and the app could not record a second thought about it. What must
   * happen is the first move, because it is the only intent that survived.
   */
  const seedQueued = async (store: IndexedDbMirrorStore, id: string, at: number, m: EngineMutation) =>
    store.putLocal(OUTBOX_TYPE, id, {
      v: OUTBOX_ENTRY_VERSION, id, key: `k-${id}`, n: 0, at, mutation: m, attempts: 0,
    });

  const seedAbandoned = async (store: IndexedDbMirrorStore, id: string, at: number, m: EngineMutation) =>
    store.putLocal(OUTBOX_ABANDONED_TYPE, id, {
      v: OUTBOX_ENTRY_VERSION, id, key: `k-${id}`, n: 0, at, mutation: m, attempts: 6, retryable: true,
    });

  it("(1) a refused replacement does not drop the verb it had marked on the wire", async () => {
    const real = new IDBFactory();
    const seed = new IndexedDbMirrorStore({ owner: "acct-r8", factory: real });
    await seed.load();
    // An abandoned DESTRUCTION on the same message: retired by anything later on that target
    // (`retiresAbandoned`), and NOT superseded by the queued move below, whose key is kind-scoped.
    await seedAbandoned(seed, "aband-1", t9 - 90_000, {
      kind: "message_delete", messageId: "giulia",
    } as EngineMutation);
    await seedQueued(seed, "queued-1", t9 - 60_000, {
      kind: "move", messageId: "giulia", folder: "ohmail/News",
    } as EngineMutation);
    seed.close();

    const faulty = faultyFactory(real);
    const store = new IndexedDbMirrorStore({ owner: "acct-r8", factory: faulty.factory });
    /** Every request, with the Idempotency-Key it carried — the server's own view. */
    const wire: Array<{ folder: string; key: string }> = [];
    let failOlder!: (e: unknown) => void;
    let held = false;
    const inner = new FixturesAdapter();
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => inner.sync(...a),
        mutate: async (m: EngineMutation, opts: { idempotencyKey: string }) => {
          wire.push({ folder: String((m as { folder?: string }).folder ?? m.kind), key: opts.idempotencyKey });
          if (!held && m.kind === "move") {
            held = true;
            await new Promise((_r, rej) => { failOlder = rej as never; });
          }
          return { changes: [], seq: 1 };
        },
      } as never,
      store, now: () => new Date(t9), outboxReplayDeadlineMs: 25,
    } as never);

    // The boot replay dispatches the queued move. It hangs past the deadline, so it is owned by
    // its request and in NO queue — and the abandoned record is still unmarked, because this road
    // never passes through `supersedeAbandoned`.
    await engine.hydrate();
    await engine.syncOnce().catch(() => undefined);
    for (let i = 0; i < 30 && wire.length === 0; i++) await tick();
    expect(
      wire.map((w) => w.folder),
      "the boot replay never put the queued move on the wire",
    ).toEqual(["ohmail/News"]);
    expect(engine.pendingMutations(), "the timed-out verb is on the queue, not the wire").toEqual([]);
    expect(
      engine.abandoned().map((r) => r.superseded === true),
      "the abandoned record was already marked, so this fixture cannot fail the marker write",
    ).toEqual([false]);

    // The reversal. Its marker write for the abandoned record is refused, so the whole verb rolls
    // back — and the mark it made on the wire must roll back with it.
    faulty.arm({
      mode: "none",
      onWrite: (_op, key) => (key.startsWith(`${OUTBOX_ABANDONED_TYPE}:`) ? "quota" : "pass"),
    });
    // A THIRD folder, not the origin: the boot replay does not paint an overlay for the restored
    // entry, so the mirror still says INBOX and a move back to INBOX would be rejected as a no-op
    // before supersession ever runs — 404, and the road untested. The destination is not what this
    // case is about; that a newer intent existed at all is.
    const refused = await engine.mutate({
      kind: "move", messageId: "giulia", folder: "ohmail/Receipts",
    } as EngineMutation);
    faulty.heal();
    expect(refused.status, "the unrecordable replacement went out anyway").toBe("rolled_back");
    expect(refused.error?.code).toBe("storage_refused");
    expect(
      wire.map((w) => w.folder),
      "the replacement reached the wire after its own refusal",
    ).toEqual(["ohmail/News"]);

    // And now the older request answers retryably.
    failOlder(new MutationRejectedError("net", { code: "network", retryable: true }));
    for (let i = 0; i < 30; i++) await tick();
    await engine.flushPending();
    for (let i = 0; i < 20; i++) await tick();

    const attempts = wire.filter((w) => w.folder === "ohmail/News");
    expect(
      attempts.length,
      "the move on the wire was dropped on behalf of a replacement that never happened — the "
        + "person's move is gone, with nothing queued, nothing on disk and no sentence anywhere",
    ).toBe(2);
    // RETRIED, not re-invented: the same Idempotency-Key is what makes the server treat the
    // second request as the first reservation rather than a second move.
    expect(
      new Set(attempts.map((a) => a.key)).size,
      "the surviving move went out under a second key, so the server saw two moves",
    ).toBe(1);
    store.close();
  });

  /**
   * THE OTHER ARM, and the pair is the point: a mark whose replacement DID happen must stand.
   * Clearing marks unconditionally would pass the case above and reintroduce the replay this whole
   * seam is about, so both directions are asserted, not one.
   */
  it("(2) a replacement that landed keeps its mark, and the older verb is still dropped", async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbMirrorStore({ owner: "acct-r8-kept", factory });
    const wire: string[] = [];
    let failOlder!: (e: unknown) => void;
    let held = false;
    const inner = new FixturesAdapter();
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => inner.sync(...a),
        mutate: async (m: EngineMutation) => {
          wire.push(String((m as { folder?: string }).folder ?? m.kind));
          if (!held) {
            held = true;
            await new Promise((_r, rej) => { failOlder = rej as never; });
          }
          return { changes: [], seq: 1 };
        },
      } as never,
      store, now: () => new Date(t9), outboxReplayDeadlineMs: 25,
    } as never);
    await engine.start();

    await engine.mutate({ kind: "move", messageId: "giulia", folder: "ohmail/News" } as EngineMutation);
    expect(wire).toEqual(["ohmail/News"]);
    // This replacement is written and dispatched — nothing is refused.
    await engine.mutate({ kind: "move", messageId: "giulia", folder: "INBOX" } as EngineMutation);

    failOlder(new MutationRejectedError("net", { code: "network", retryable: true }));
    for (let i = 0; i < 30; i++) await tick();
    await engine.flushPending();
    for (let i = 0; i < 20; i++) await tick();

    expect(
      wire.filter((w) => w === "ohmail/News").length,
      "the superseded move replayed over the reversal that replaced it",
    ).toBe(1);
    expect(engine.read().get<EngineMessage>("message", "giulia")?.folder).toBe("INBOX");
    store.close();
  });

  /**
   * ── THE THIRD ARM: WHOSE MARK IS IT? ────────────────────────────────────────────────────────
   *
   * The undo clears only what ITS OWN call marked. Clearing every mark on the entry instead passes
   * both arms above, so this is the case that tells them apart.
   *
   * A verb is on the wire; B replaces it and is queued behind the hold; C replaces B and cannot be
   * written. C's rollback puts B back — and B's mark on the wire must STAND, because B is the verb
   * that replaces A and B is still standing. Clear it and A survives with a server-named backoff
   * while B has none, so the next drive sends B and the drive after the backoff sends A ON TOP OF
   * IT: the older destination is the server's last word, which is the whole defect this seam is
   * about, reintroduced through the rollback.
   */
  it("(3) a rollback keeps the mark an EARLIER replacement made, and the older verb stays dropped", async () => {
    const real = new IDBFactory();
    const faulty = faultyFactory(real);
    const store = new IndexedDbMirrorStore({ owner: "acct-r8-earlier", factory: faulty.factory });
    const wire: string[] = [];
    let failOlder!: (e: unknown) => void;
    let held = false;
    let clock = t9;
    const inner = new FixturesAdapter();
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => inner.sync(...a),
        mutate: async (m: EngineMutation) => {
          wire.push(String((m as { folder?: string }).folder ?? m.kind));
          if (!held) {
            held = true;
            await new Promise((_r, rej) => { failOlder = rej as never; });
          }
          return { changes: [], seq: 1 };
        },
      } as never,
      store, now: () => new Date(clock), outboxReplayDeadlineMs: 25,
    } as never);
    await engine.start();

    // A — on the wire, owned by its request, in no queue.
    await engine.mutate({ kind: "move", messageId: "giulia", folder: "ohmail/News" } as EngineMutation);
    expect(wire, "the first move never reached the wire").toEqual(["ohmail/News"]);
    // B — marks A, and is queued behind the hold A's timeout armed.
    await engine.mutate({ kind: "move", messageId: "giulia", folder: "INBOX" } as EngineMutation);
    expect(engine.pendingMutations().length, "the replacement is not queued").toBe(1);

    // C — retires B and cannot be written, so none of it happened and B goes back.
    faulty.arm({ mode: "none", onWrite: (_op, key) => (key.startsWith(`${OUTBOX_TYPE}:`) ? "quota" : "pass") });
    const refused = await engine.mutate({
      kind: "move", messageId: "giulia", folder: "ohmail/Receipts",
    } as EngineMutation);
    faulty.heal();
    expect(refused.status).toBe("rolled_back");
    expect(
      engine.pendingMutations().map((p) => (p.mutation as { folder?: string }).folder),
      "the queued replacement it would have retired was not put back",
    ).toEqual(["INBOX"]);

    // A answers with a COUNTED server failure, so a surviving A would carry a backoff B has not.
    failOlder(SERVER_500());
    for (let i = 0; i < 30; i++) await tick();
    // The drive that follows sends whatever is due now.
    await engine.flushPending();
    for (let i = 0; i < 20; i++) await tick();
    // …and then the backoff elapses.
    clock += OUTBOX_BACKOFF_CAP_MS + 1;
    await engine.flushPending();
    for (let i = 0; i < 20; i++) await tick();

    expect(
      wire.filter((w) => w === "ohmail/News").length,
      "the rollback cleared a mark that was not its own, so the verb the standing replacement had "
        + "superseded came back",
    ).toBe(1);
    expect(
      wire[wire.length - 1],
      "the older destination is the server's last word — the replay this seam exists to stop",
    ).toBe("INBOX");
    store.close();
  });
});

/**
 * ROUND NINE: THE OLDER REQUEST ANSWERS INSIDE THE REPLACEMENT'S WRITE WINDOW. Round eight's road,
 * with the replacement's write HELD rather than refused at once: the older move answers retryably
 * while it is held. The drop used to happen there, before the write had decided anything, so a
 * write refused afterwards undid a mark on a verb already gone. The mark names its replacement and
 * the drop waits for that replacement's write. Mutation: the drop not waiting → case (1) red.
 */
describe("round nine: a mark is confirmed by its replacement's write", () => {
  const t11 = Date.parse("2026-09-27T09:00:00.000Z");
  const tick = (): Promise<void> => new Promise<void>((r) => { setTimeout(r, 5); });

  async function scene(owner: string) {
    const real = new IDBFactory();
    const seed = new IndexedDbMirrorStore({ owner, factory: real });
    await seed.load();
    await seed.putLocal(OUTBOX_ABANDONED_TYPE, "aband-1", {
      v: OUTBOX_ENTRY_VERSION, id: "aband-1", key: "k-aband-1", n: 0, at: t11 - 90_000,
      mutation: { kind: "message_delete", messageId: "giulia" }, attempts: 6, retryable: true,
    });
    await seed.putLocal(OUTBOX_TYPE, "queued-1", {
      v: OUTBOX_ENTRY_VERSION, id: "queued-1", key: "k-queued-1", n: 0, at: t11 - 60_000,
      mutation: { kind: "move", messageId: "giulia", folder: "ohmail/News" }, attempts: 0,
    });
    seed.close();

    const store = new IndexedDbMirrorStore({ owner, factory: real });
    /* The replacement's marker write, held until the case decides how it ends. */
    let holdNext = false;
    let endWrite!: (refuse: boolean) => void;
    const commit = store.commitLocal.bind(store);
    (store as unknown as { commitLocal: typeof store.commitLocal }).commitLocal = async (puts, dels) => {
      if (holdNext && puts.some((p) => p.type === OUTBOX_ABANDONED_TYPE)) {
        holdNext = false;
        if (await new Promise<boolean>((r) => { endWrite = r; })) throw new Error("QuotaExceededError");
      }
      return commit(puts, dels);
    };
    const wire: Array<{ folder: string; key: string }> = [];
    let failOlder!: (e: unknown) => void;
    let held = false;
    const inner = new FixturesAdapter();
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => inner.sync(...a),
        mutate: async (m: EngineMutation, opts: { idempotencyKey: string }) => {
          wire.push({ folder: String((m as { folder?: string }).folder ?? m.kind), key: opts.idempotencyKey });
          if (!held && m.kind === "move") {
            held = true;
            await new Promise((_r, rej) => { failOlder = rej as never; });
          }
          return { changes: [], seq: 1 };
        },
      } as never,
      store, now: () => new Date(t11), outboxReplayDeadlineMs: 25,
    } as never);
    await engine.hydrate();
    await engine.syncOnce().catch(() => undefined);
    for (let i = 0; i < 30 && wire.length === 0; i++) await tick();
    expect(wire.map((w) => w.folder), "the boot replay never put the queued move on the wire").toEqual(["ohmail/News"]);
    return {
      engine, store, wire,
      holdTheNextMarker: () => { holdNext = true; },
      endWrite: (refuse: boolean) => endWrite(refuse),
      failOlder: () => failOlder(new MutationRejectedError("net", { code: "network", retryable: true })),
    };
  }

  it("(1) a write refused AFTER the older verb answered does not drop it: it goes out again, same key", async () => {
    const s = await scene("acct-r9-refused");
    s.holdTheNextMarker();
    const reversal = s.engine.mutate({ kind: "move", messageId: "giulia", folder: "ohmail/Receipts" } as EngineMutation);
    for (let i = 0; i < 6; i++) await tick();
    // The older request answers INSIDE the window: the replacement's write has decided nothing yet.
    s.failOlder();
    for (let i = 0; i < 6; i++) await tick();
    s.endWrite(true);
    const refused = await reversal;
    expect(refused.error?.code, "the held write was not the one refused").toBe("storage_refused");
    for (let i = 0; i < 20; i++) await tick();
    await s.engine.flushPending();
    for (let i = 0; i < 20; i++) await tick();

    const attempts = s.wire.filter((w) => w.folder === "ohmail/News");
    expect(
      attempts.length,
      "the move was dropped for a replacement whose write was then refused — the only intent left, gone",
    ).toBe(2);
    expect(new Set(attempts.map((a) => a.key)).size, "the surviving move went out under a second key").toBe(1);
    expect(s.wire.some((w) => w.folder === "ohmail/Receipts"), "the refused replacement reached the wire").toBe(false);
    s.store.close();
  });

  it("(2) a write that LANDS after the older verb answered confirms the mark: the older verb stays dropped", async () => {
    const s = await scene("acct-r9-landed");
    s.holdTheNextMarker();
    const reversal = s.engine.mutate({ kind: "move", messageId: "giulia", folder: "ohmail/Receipts" } as EngineMutation);
    for (let i = 0; i < 6; i++) await tick();
    s.failOlder();
    for (let i = 0; i < 6; i++) await tick();
    s.endWrite(false);
    await reversal;
    for (let i = 0; i < 20; i++) await tick();
    await s.engine.flushPending();
    for (let i = 0; i < 20; i++) await tick();

    expect(
      s.wire.filter((w) => w.folder === "ohmail/News").length,
      "the superseded move replayed over the reversal whose write landed",
    ).toBe(1);
    expect(s.wire[s.wire.length - 1]?.folder, "the reversal is not the server's last word").toBe("ohmail/Receipts");
    s.store.close();
  });
});

/**
 * A READ ON THE WIRE IS MARKED BY A NEWER READ ON ITS IDS (`readsTaken`), and the mark is the read
 * verbs' round eight: a Mark unread whose write is refused never happened, so it reaches no wire
 * and takes nothing from the glance, which goes again whole, under its key. Mutations: the mark not
 * put back → the glance is dropped; the refused write still sent → the unread reaches the wire.
 */
describe("a read on the wire and a newer read whose write is refused", () => {
  const tick = (): Promise<void> => new Promise<void>((r) => { setTimeout(r, 5); });

  it("the refused Mark unread reaches no wire, and the glance goes again whole, same key", async () => {
    const faulty = faultyFactory(new IDBFactory());
    const store = new IndexedDbMirrorStore({ owner: "acct-read-refused", factory: faulty.factory });
    const wire: Array<{ said: string; key: string }> = [];
    let failGlance!: (e: unknown) => void;
    const inner = new FixturesAdapter();
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
        sync: (...a: Parameters<FixturesAdapter["sync"]>) => inner.sync(...a),
        mutate: async (m: EngineMutation, opts: { idempotencyKey: string }) => {
          const r = m as { messageIds?: string[]; unread?: boolean };
          wire.push({ said: `${(r.messageIds ?? []).join(",")} ${r.unread ? "unread" : "read"}`, key: opts.idempotencyKey });
          if (wire.length === 1) await new Promise((_r, rej) => { failGlance = rej as never; });
          return { changes: [], seq: 1 };
        },
      } as never,
      store, now: () => new Date(Date.parse("2026-10-29T09:00:00.000Z")),
    } as never);
    await engine.start();

    const glance = engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false, via: "glance" } as EngineMutation);
    for (let i = 0; i < 30 && wire.length === 0; i++) await tick();
    faulty.arm({ mode: "none", onWrite: (_op, key) => (key.startsWith(`${OUTBOX_TYPE}:`) ? "quota" : "pass") });
    const unread = engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: true } as EngineMutation);
    for (let i = 0; i < 10; i++) await tick();
    faulty.heal();
    failGlance(new MutationRejectedError("net", { code: "network", retryable: true }));
    const [, refused] = await Promise.all([glance, unread]);
    expect(refused.error?.code, "the unrecordable Mark unread went out anyway").toBe("storage_refused");
    await engine.flushPending();

    expect(wire.map((w) => w.said), "the glance lost its letter to a Mark unread that never happened").toEqual(["giulia read", "giulia read"]);
    expect(new Set(wire.map((w) => w.key)).size, "the glance went again under a second key").toBe(1);
    store.close();
  });
});

/**
 * ROUND SIX'S RESIDUE.
 *
 * two fixes were in the code with controls that stayed green when they were reverted.:
 * findings 5 to 11, left by the review cap. Each case below is the reviewer's own sequence, and
 * each names the line whose mutation reddens it.
 */
describe("round six residue: the late answer, the discarded record, and findings 5 to 11", () => {
  const t10 = Date.parse("2026-09-08T09:00:00.000Z");
  const tick = (): Promise<void> => new Promise<void>((r) => { setTimeout(r, 5); });
  const settle = async (n = 20): Promise<void> => { for (let i = 0; i < n; i++) await tick(); };
  const fixtures = (): { fetchBody: unknown; sync: unknown } => {
    const inner = new FixturesAdapter();
    return {
      fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
      sync: (...a: Parameters<FixturesAdapter["sync"]>) => inner.sync(...a),
    };
  };

  it("a late answer that lands while a flush is OPEN is handed over by that flush", async () => {
    /**
     * The case the round-six fixtures could not produce. A verb whose request outran its deadline
     * settles at a moment nobody chooses, and very often that moment is inside the flush waiting
     * for it: the flush's own timed-out entry armed the barrier, and the reconcile drain that
     * follows is exactly where the answer arrives. Claimed only on the way IN, it sat in the map
     * until some later flush happened to run — and for a send that map holds the settlement a
     * locked composer is waiting on. The claim is taken again on the way OUT.
     */
    const factory = new IDBFactory();
    const store = new IndexedDbMirrorStore({ owner: "acct-r6r-late", factory });
    const wire: string[] = [];
    let calls = 0;
    let releaseSlow!: (v: unknown) => void;
    let inSync = false;
    let openSync!: () => void;
    let syncGate: Promise<void> | null = null;
    const inner = new FixturesAdapter();
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
        sync: async (...a: Parameters<FixturesAdapter["sync"]>) => {
          if (syncGate !== null) {
            const gate = syncGate;
            syncGate = null;
            inSync = true;
            await gate;
          }
          return inner.sync(...a);
        },
        mutate: async (m: EngineMutation) => {
          const tag = (m as { messageId?: string }).messageId ?? m.kind;
          wire.push(tag);
          calls += 1;
          // Both verbs are refused retryably first, so both are on the QUEUE when the flush runs.
          if (calls <= 2) throw new MutationRejectedError("net", { code: "network", retryable: true });
          if (tag === "petra") {
            await new Promise((r) => { releaseSlow = r as never; });
            return { changes: [], seq: 9 };
          }
          return { changes: [], seq: 8 };
        },
      } as never,
      store, now: () => new Date(t10), outboxReplayDeadlineMs: 25,
    } as never);
    await engine.start();

    await engine.mutate({ kind: "triage_set", messageId: "giulia", state: "reply_later" } as EngineMutation);
    const slow = await engine.mutate({ kind: "triage_set", messageId: "petra", state: "reply_later" } as EngineMutation);
    expect(engine.pendingMutations(), "both verbs should be queued by the refusals").toHaveLength(2);

    // The flush dispatches giulia (confirmed, so a reconcile is owed) and then petra, which hangs
    // past its deadline. The flush is OPEN — inside that owed drain — when petra's answer lands.
    syncGate = new Promise<void>((r) => { openSync = r; });
    const flush = engine.flushPending();
    for (let i = 0; i < 60 && !inSync; i++) await tick();
    expect(inSync, "the flush never reached its reconcile drain — the window is not staged").toBe(true);
    releaseSlow({ changes: [], seq: 9 });
    await settle(6);
    openSync();

    const out = await flush;
    expect(
      out.some((r) => r.id === slow.id && r.status !== "queued"),
      "the settlement that landed inside this flush was left for an arbitrary later one — the "
        + "composer stays locked on mail that has already gone",
    ).toBe(true);
    store.close();
  });

  it("a superseded in-flight verb leaves no durable row for the next boot to replay", async () => {
    /**
     * The wire mark keeps the older verb off the queue; the ROW is the other half. Leave it on
     * disk and the next boot restores it and replays the older destination over the newer state —
     * the same defect, one restart later, with nothing on screen to explain it.
     */
    const factory = new IDBFactory();
    const store = new IndexedDbMirrorStore({ owner: "acct-r6r-durable", factory });
    const wire: string[] = [];
    let failOlder!: (e: unknown) => void;
    let held = false;
    const engine = new OhmailEngine({
      adapter: {
        ...fixtures(),
        mutate: async (m: EngineMutation) => {
          wire.push(String((m as { folder?: string }).folder ?? m.kind));
          if (!held) {
            held = true;
            await new Promise((_r, rej) => { failOlder = rej as never; });
          }
          return { changes: [], seq: 1 };
        },
      } as never,
      store, now: () => new Date(t10), outboxReplayDeadlineMs: 25,
    } as never);
    await engine.start();

    await engine.mutate({ kind: "move", messageId: "giulia", folder: "ohmail/News" } as EngineMutation);
    expect(wire, "the older move never reached the wire").toEqual(["ohmail/News"]);
    await engine.mutate({ kind: "move", messageId: "giulia", folder: "INBOX" } as EngineMutation);

    failOlder(new MutationRejectedError("net", { code: "network", retryable: true }));
    await settle(30);

    const folders = rows(store, OUTBOX_TYPE)
      .map((r) => ((r.entity as { mutation?: { folder?: string } }).mutation?.folder));
    expect(
      folders.includes("ohmail/News"),
      "the superseded verb's durable row survived, so the next boot replays the older destination",
    ).toBe(false);
    store.close();
  });

  /**
   * A record whose terminal transition the STORE refused: it lives only in the session-local
   * fallback, while its live row is still on disk. That is the state findings 5 and 6 are about.
   */
  async function withFallbackRecord(owner: string): Promise<{
    engine: OhmailEngine;
    store: IndexedDbMirrorStore;
    factory: IDBFactory;
    wire: string[];
    refuse: { on: boolean };
  }> {
    const factory = new IDBFactory();
    const seed = new IndexedDbMirrorStore({ owner, factory });
    await seed.load();
    await seed.putLocal(OUTBOX_TYPE, "fallback-1", {
      v: OUTBOX_ENTRY_VERSION, id: "fallback-1", key: "k-fallback-1", n: 0, at: t10 - 60_000,
      mutation: VERB, attempts: 0,
    });
    seed.close();

    const faulty = faultyFactory(factory);
    const store = new IndexedDbMirrorStore({ owner, factory: faulty.factory });
    const wire: string[] = [];
    const refuse = { on: true };
    const engine = new OhmailEngine({
      adapter: {
        ...fixtures(),
        mutate: async (m: EngineMutation) => {
          wire.push((m as { messageId?: string }).messageId ?? m.kind);
          if (refuse.on) {
            throw new MutationRejectedError("that conversation is no longer in your mailbox",
              { status: 404, code: "not_found", retryable: false });
          }
          return { changes: [], seq: 1 };
        },
      } as never,
      store, now: () => new Date(t10),
    } as never);
    await engine.hydrate();
    faulty.arm({
      mode: "none",
      onWrite: (_op: string, key: string) => (key.startsWith(`${OUTBOX_ABANDONED_TYPE}:`) ? "quota" : "pass"),
    });
    await engine.syncOnce();
    faulty.heal();
    expect(faulty.log.broken, "the injected storage fault never fired").toBeGreaterThan(0);
    expect(engine.abandoned().map((r) => r.id)).toEqual(["fallback-1"]);
    expect(rows(store, OUTBOX_TYPE), "the live row is what a reboot replays").toHaveLength(1);
    return { engine, store, factory, wire, refuse };
  }

  it("(5) Discard takes the live durable row with it, so a reboot cannot replay what was thrown away", async () => {
    const { engine, store, factory } = await withFallbackRecord("acct-r6r-discard");
    await engine.discardAbandoned("fallback-1");
    expect(engine.abandoned(), "Discard left the row listed").toHaveLength(0);
    expect(
      rows(store, OUTBOX_TYPE),
      "Discard deleted the abandoned record and left the LIVE row — the one the next boot replays",
    ).toHaveLength(0);
    store.close();

    const store2 = new IndexedDbMirrorStore({ owner: "acct-r6r-discard", factory });
    const wire2: string[] = [];
    const engine2 = new OhmailEngine({
      adapter: {
        ...fixtures(),
        mutate: async (m: EngineMutation) => {
          wire2.push((m as { messageId?: string }).messageId ?? m.kind);
          return { changes: [], seq: 1 };
        },
      } as never,
      store: store2, now: () => new Date(t10),
    } as never);
    await engine2.hydrate();
    await engine2.syncOnce().catch(() => undefined);
    await settle();
    expect(wire2, "the discarded verb went out on the next boot").toEqual([]);
    store2.close();
  });

  it("(5) a Retry that lands clears the session-local record with it", async () => {
    const { engine, store, refuse } = await withFallbackRecord("acct-r6r-retry");
    refuse.on = false;
    const out = await engine.retryAbandoned("fallback-1");
    expect(out.status, "the retry was refused, so this case measures nothing").not.toBe("rolled_back");
    await settle();
    expect(
      engine.abandoned(),
      "the retried record was listed again from the session-local copy, offering a second Try "
        + "again for a verb already back in the queue",
    ).toHaveLength(0);
    store.close();
  });

  it("(6) a newer verb for the same target supersedes a record the store could not write", async () => {
    const { engine, store, refuse } = await withFallbackRecord("acct-r6r-supersede");
    refuse.on = false;
    await engine.mutate({ kind: "triage_set", messageId: "petra", state: "set_aside" } as EngineMutation);
    const listed = engine.abandoned();
    expect(listed, "the fallback record disappeared instead of being marked").toHaveLength(1);
    expect(
      listed[0]?.superseded,
      "the supersession scanned disk alone, so Try again on this record would overwrite the state "
        + "the newer verb has just established",
    ).toBe(true);
    expect(listed[0]?.retryable).toBe(false);
    store.close();
  });

  it("(7) a narrowing-only replacement whose write is refused reaches no wire", async () => {
    const real = new IDBFactory();
    const faulty = faultyFactory(real);
    const store = new IndexedDbMirrorStore({ owner: "acct-r6r-narrow", factory: faulty.factory });
    const wire: EngineMutation[] = [];
    let fail = true;
    const engine = new OhmailEngine({
      adapter: {
        ...fixtures(),
        mutate: async (m: EngineMutation) => {
          wire.push(m);
          if (fail) throw new MutationRejectedError("net", { code: "network", retryable: true });
          return { changes: [], seq: 1 };
        },
      } as never,
      store, now: () => new Date(t10),
    } as never);
    await engine.start();

    await engine.mutate({
      kind: "mark_seen", messageIds: ["giulia", "petra"], unread: true,
    } as unknown as EngineMutation);
    expect(engine.pendingMutations(), "the older read verb is not queued").toHaveLength(1);
    const before = wire.length;
    fail = false;

    // The newer verb names ONE of the two: the queued entry is NARROWED and nothing is RETIRED,
    // which is the whole point — `retired.length > 0` alone did not see this verb at all.
    faulty.arm({
      mode: "none",
      onWrite: (_op: string, key: string) => (key.startsWith(`${OUTBOX_TYPE}:`) ? "quota" : "pass"),
    });
    const refused = await engine.mutate({
      kind: "mark_seen", messageIds: ["giulia"], unread: false,
    } as unknown as EngineMutation);
    faulty.heal();

    expect(refused.status).toBe("rolled_back");
    expect(refused.error?.code).toBe("storage_refused");
    expect(
      wire.length,
      "the replacement went on the wire with no record of it on this device, over an older intent "
        + "disk still holds whole — the next boot replays that one on top",
    ).toBe(before);
    expect(
      (engine.pendingMutations()[0]?.mutation as { messageIds?: string[] }).messageIds,
      "the narrowed queue entry was not put back",
    ).toEqual(["giulia", "petra"]);
    store.close();
  });

  it("(8) a refused replacement leaves NEITHER of the records it would have marked", async () => {
    /**
     * The marks were separate transactions written ahead of the replacement. One could commit
     * while a sibling or the replacement failed — and then an older record was superseded for a
     * verb that never happened, its Try again gone for a reason that turned out not to exist. A
     * crash between the two writes had the same outcome and no rollback to attempt. One
     * transaction makes the half-state unrepresentable.
     */
    const real = new IDBFactory();
    const seed = new IndexedDbMirrorStore({ owner: "acct-r6r-marks", factory: real });
    await seed.load();
    for (const id of ["aband-a", "aband-b"]) {
      await seed.putLocal(OUTBOX_ABANDONED_TYPE, id, {
        v: OUTBOX_ENTRY_VERSION, id, key: `k-${id}`, n: 0, at: t10 - 90_000,
        mutation: { kind: "message_delete", messageId: "giulia" },
        attempts: OUTBOX_MAX_SERVER_FAILURES,
      });
    }
    seed.close();

    const faulty = faultyFactory(real);
    const store = new IndexedDbMirrorStore({ owner: "acct-r6r-marks", factory: faulty.factory });
    const wire: string[] = [];
    const engine = new OhmailEngine({
      adapter: {
        ...fixtures(),
        mutate: async (m: EngineMutation) => {
          wire.push(String((m as { folder?: string }).folder ?? m.kind));
          return { changes: [], seq: 1 };
        },
      } as never,
      store, now: () => new Date(t10),
    } as never);
    await engine.start();
    expect(engine.abandoned().map((r) => r.superseded), "seeded already marked").toEqual([false, false]);

    // The replacement's own row is refused; the two marks ride the same transaction.
    faulty.arm({
      mode: "none",
      onWrite: (_op: string, key: string) => (key.startsWith(`${OUTBOX_TYPE}:`) ? "quota" : "pass"),
    });
    const refused = await engine.mutate({
      kind: "move", messageId: "giulia", folder: "ohmail/News",
    } as EngineMutation);
    faulty.heal();

    expect(refused.status).toBe("rolled_back");
    expect(wire, "the unrecordable replacement reached the wire").toEqual([]);
    expect(
      engine.abandoned().map((r) => r.superseded),
      "a record was marked stale on behalf of a replacement that never happened — its Try again "
        + "is gone for a reason that turned out not to exist",
    ).toEqual([false, false]);
    store.close();
  });

  it("(10) two concurrent Retries for one record dispatch ONCE", async () => {
    /**
     * Both presses read the record before either transition committed, and both dispatched. For a
     * draft create — whose route ignores the idempotency key — that is a second row on the server.
     */
    const factory = new IDBFactory();
    const seed = new IndexedDbMirrorStore({ owner: "acct-r6r-twice", factory });
    await seed.load();
    await seed.putLocal(OUTBOX_ABANDONED_TYPE, "aband-retry", {
      v: OUTBOX_ENTRY_VERSION, id: "aband-retry", key: "k-aband-retry", n: 0, at: t10 - 90_000,
      mutation: VERB, attempts: OUTBOX_MAX_SERVER_FAILURES,
    });
    seed.close();

    const store = new IndexedDbMirrorStore({ owner: "acct-r6r-twice", factory });
    const wire: string[] = [];
    let release!: (v: unknown) => void;
    const engine = new OhmailEngine({
      adapter: {
        ...fixtures(),
        mutate: async (m: EngineMutation) => {
          wire.push((m as { messageId?: string }).messageId ?? m.kind);
          await new Promise((r) => { release = r as never; });
          return { changes: [], seq: 1 };
        },
      } as never,
      store, now: () => new Date(t10), outboxReplayDeadlineMs: 5_000,
    } as never);
    await engine.start();
    expect(engine.abandoned()).toHaveLength(1);

    const first = engine.retryAbandoned("aband-retry");
    const second = engine.retryAbandoned("aband-retry");
    await settle(10);
    expect(
      wire.length,
      "both presses dispatched — for a create, whose route ignores the key, that is a second row",
    ).toBe(1);
    release({ changes: [], seq: 1 });
    const [a, b] = await Promise.all([first, second]);
    expect(b.id, "the second press got a different verb's answer").toBe(a.id);
    store.close();
  });

  it("(11) two concurrent partial supersessions both land", async () => {
    /**
     * `commitLocal` publishes to memory only when its transaction RESOLVES, so two verbs narrowing
     * one abandoned read record both read `{giulia, petra}` and wrote `{petra}` and `{giulia}`.
     * One stale fragment survived, and Try again on it re-applied an id the newer verb had already
     * delivered — undoing what the person had just done.
     */
    const factory = new IDBFactory();
    const seed = new IndexedDbMirrorStore({ owner: "acct-r6r-cas", factory });
    await seed.load();
    await seed.putLocal(OUTBOX_ABANDONED_TYPE, "aband-read", {
      v: OUTBOX_ENTRY_VERSION, id: "aband-read", key: "k-aband-read", n: 0, at: t10 - 90_000,
      mutation: { kind: "mark_seen", messageIds: ["giulia", "petra"], unread: true },
      attempts: OUTBOX_MAX_SERVER_FAILURES,
    });
    seed.close();

    const store = new IndexedDbMirrorStore({ owner: "acct-r6r-cas", factory });
    const engine = new OhmailEngine({
      adapter: {
        ...fixtures(),
        mutate: async () => ({ changes: [], seq: 1 }),
      } as never,
      store, now: () => new Date(t10),
    } as never);
    await engine.start();
    expect(engine.abandoned()).toHaveLength(1);

    await Promise.all([
      engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false } as unknown as EngineMutation),
      engine.mutate({ kind: "mark_seen", messageIds: ["petra"], unread: false } as unknown as EngineMutation),
    ]);
    await settle(6);

    const listed = engine.abandoned();
    expect(listed).toHaveLength(1);
    expect(
      listed[0]?.superseded,
      "one narrowing overwrote the other, so a stale fragment survived and Try again re-applies "
        + "an id the newer verb already delivered",
    ).toBe(true);
    store.close();
  });
});

/**
 * THE OTHER HALF OF THE FIRST CASE: whose answer is it?
 *
 * `flushPending` is a DESTRUCTIVE reader, and there can be two of them open at once. Emptying the
 * map wholesale takes the settlement another open flush has already claimed and is about to hand
 * to the surface waiting for it — removed by an unrelated consumer and dropped on the floor. The
 * claim is what makes "handed over by id" mean anything, so both are asserted here.
 */
describe("round six residue: a late answer belongs to the flush that claimed it", () => {
  const t11 = Date.parse("2026-09-08T10:00:00.000Z");
  const tick = (): Promise<void> => new Promise<void>((r) => { setTimeout(r, 5); });
  const settle = async (n = 20): Promise<void> => { for (let i = 0; i < n; i++) await tick(); };

  it("a second flush does not take the answer the first one is holding", async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbMirrorStore({ owner: "acct-r6r-two-flushes", factory });
    const wire: string[] = [];
    let releaseFirst!: (v: unknown) => void;
    let releaseSlow!: (v: unknown) => void;
    let inSync = false;
    let openSync!: () => void;
    let syncGate: Promise<void> | null = null;
    let refuseOnce = new Set(["giulia", "petra"]);
    const inner = new FixturesAdapter();
    const engine = new OhmailEngine({
      adapter: {
        fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
        sync: async (...a: Parameters<FixturesAdapter["sync"]>) => {
          if (syncGate !== null) {
            const gate = syncGate;
            syncGate = null;
            inSync = true;
            await gate;
          }
          return inner.sync(...a);
        },
        mutate: async (m: EngineMutation) => {
          const tag = (m as { messageId?: string }).messageId ?? m.kind;
          wire.push(tag);
          if (refuseOnce.has(tag)) {
            refuseOnce.delete(tag);
            throw new MutationRejectedError("net", { code: "network", retryable: true });
          }
          if (tag === "techcheck") {
            await new Promise((r) => { releaseFirst = r as never; });
            return { changes: [], seq: 7 };
          }
          if (tag === "petra") {
            await new Promise((r) => { releaseSlow = r as never; });
            return { changes: [], seq: 9 };
          }
          return { changes: [], seq: 8 };
        },
      } as never,
      store, now: () => new Date(t11), outboxReplayDeadlineMs: 25,
    } as never);
    await engine.start();

    // ONE: a verb whose request outran its deadline, settled, and whose answer is in the map.
    const first = await engine.mutate({
      kind: "triage_set", messageId: "techcheck", state: "reply_later",
    } as EngineMutation);
    releaseFirst({ changes: [], seq: 7 });
    await settle(8);
    expect(engine.hasLateResults(), "the first answer never landed").toBe(true);

    // TWO more verbs, both queued by a refusal, so the flush below has a batch.
    await engine.mutate({ kind: "triage_set", messageId: "giulia", state: "reply_later" } as EngineMutation);
    const slow = await engine.mutate({ kind: "triage_set", messageId: "petra", state: "reply_later" } as EngineMutation);
    expect(engine.pendingMutations()).toHaveLength(2);

    // Flush A claims the first answer and then blocks inside its reconcile drain.
    syncGate = new Promise<void>((r) => { openSync = r; });
    const flushA = engine.flushPending();
    for (let i = 0; i < 60 && !inSync; i++) await tick();
    expect(inSync, "flush A never reached its reconcile drain — the window is not staged").toBe(true);

    // Petra's own answer lands while flush A is open, and flush B takes THAT one.
    releaseSlow({ changes: [], seq: 9 });
    await settle(6);
    const flushB = engine.flushPending();
    await settle(6);
    openSync();
    const [outA, outB] = await Promise.all([flushA, flushB]);

    expect(
      outB.some((r) => r.id === slow.id && r.status !== "queued"),
      "flush B did not receive the answer that landed while A was open",
    ).toBe(true);
    expect(
      outA.some((r) => r.id === first.id && r.status !== "queued"),
      "flush B emptied the map wholesale and took the settlement flush A was holding — an "
        + "unrelated consumer removed it and dropped it on the floor",
    ).toBe(true);
    store.close();
  });
});
