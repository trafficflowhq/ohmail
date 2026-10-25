/**
 * THE OUTBOX GIVES UP — and only on the failures that deserve it.
 *
 * ── WHAT WAS TRUE BEFORE THIS ────────────────────────────────────────────────────────────────
 *
 * A retryable rejection re-queued with no counter, no delay and no end: `queue.push(p)`,
 * re-persist, try again on the next drive, for ever, across restarts. That is correct for the case
 * it was written for — a laptop with no network — and wrong for a verb the server will refuse
 * identically every time. `HttpAdapter` classifies any unhandled 500 as retryable by DEFAULT
 * (`retryable ?? (status >= 500 || status === 429)`), so one mis-shaped request became a permanent
 * background loop holding the user's overlay open and saying nothing.
 *
 * ── THE TWO HALVES, AND WHY THE SECOND IS THE HARDER ONE ─────────────────────────────────────
 *
 * Bounding it is easy. Bounding it WITHOUT throwing away work that would have landed is the whole
 * problem, and it is the half a careless ceiling gets wrong: count every failure and a twenty-minute
 * connection-pool outage abandons every legitimate verb in flight, which is a far bigger loss than
 * the loop being closed. So only a SERVER-ANSWERED failure counts — never `network`, never
 * `timeout`, and never a refusal carrying `Retry-After`, which is a server declining work it knows
 * it cannot do yet and saying when to come back.
 *
 * Both halves are asserted here. The offline case (`never abandons`) is not a nice-to-have beside
 * the ceiling; it is the assertion that stops the ceiling from becoming a data-loss feature.
 */
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  FixturesAdapter,
  IndexedDbMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  OUTBOX_ABANDONED_TYPE,
  OUTBOX_BACKOFF_BASE_MS,
  OUTBOX_BACKOFF_CAP_MS,
  OUTBOX_MAX_SERVER_FAILURES,
  OUTBOX_TYPE,
  CursorExpiredError,
  type EngineAdapter,
  type EngineMutation,
} from "@ohmail/client-engine";

/** A 500 with no `retryable` field — what an unhandled server fault actually looks like. */
const SERVER_500 = (): MutationRejectedError =>
  new MutationRejectedError("internal error", { status: 500, code: "internal", retryable: true });

/** The offline shape: no answer ever reached us. */
const OFFLINE = (): MutationRejectedError =>
  new MutationRejectedError("network failure", { code: "network", retryable: true });

/** A starved pool declining work it knows it cannot do yet, and naming the interval. */
const DB_BUSY = (): MutationRejectedError =>
  new MutationRejectedError("database busy", {
    status: 503, code: "db_busy", retryable: true, retryAfterMs: 2_000,
  });

interface Rig {
  adapter: EngineAdapter;
  mutates: number;
  fail: (fn: (() => Error) | null) => void;
  /** Throw this from the NEXT sync, once — the 410 path needs a real cursor expiry. */
  failNextSync: (err: Error) => void;
}

function rig(inner: FixturesAdapter): Rig {
  let failWith: (() => Error) | null = null;
  let syncFailure: Error | null = null;
  const r: Rig = {
    mutates: 0,
    fail: (fn) => { failWith = fn; },
    failNextSync: (err) => { syncFailure = err; },
    adapter: {
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: () => inner.fetchBody(),
      sync: (params) => {
        if (syncFailure) {
          const e = syncFailure;
          syncFailure = null;
          throw e;
        }
        return inner.sync(params);
      },
      async mutate(m, o) {
        r.mutates += 1;
        if (failWith) throw failWith();
        const out = await inner.mutate(m, o);
        return { changes: [], seq: out.seq };
      },
    },
  };
  return r;
}

/** A clock the test moves by hand — the backoff is time, so it has to be observable. */
function clock(start = Date.parse("2026-09-04T12:00:00.000Z")) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
}

const VERB: EngineMutation = { kind: "mark_seen", messageIds: ["giulia"], unread: false };

const rowsOf = (store: IndexedDbMirrorStore, type: string): unknown[] =>
  store.entries<unknown>(type).map((r) => r.entity);

describe("the durable outbox gives up after a bounded number of server-answered failures", () => {
  it("stops dispatching at the ceiling, lands the verb in the abandoned list, and reverts the row", async () => {
    const factory = new IDBFactory();
    const c = clock();
    const w = rig(new FixturesAdapter());
    const store = new IndexedDbMirrorStore({ owner: "acct-bound", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: c.now });
    await engine.start();

    let notified = 0;
    engine.subscribe(() => { notified += 1; });

    w.fail(SERVER_500);
    const first = await engine.mutate(VERB);
    expect(first.status).toBe("queued");
    const dispatchesAfterMutate = w.mutates;

    // Drive far more times than the ceiling, advancing past each backoff so the delay is never
    // what stops it — the CEILING has to be the thing that stops it, not the clock.
    for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES * 3; i++) {
      c.advance(OUTBOX_BACKOFF_CAP_MS + 1);
      await engine.syncOnce();
    }

    // The verb was dispatched exactly `OUTBOX_MAX_SERVER_FAILURES` times in total and then never
    // again. Counted as a TOTAL rather than a delta, because "it stopped growing" is also true of
    // a queue that is merely stuck.
    expect(dispatchesAfterMutate).toBe(1);
    expect(w.mutates).toBe(OUTBOX_MAX_SERVER_FAILURES);

    // It left the replay set entirely — not flagged inside it, which is what keeps the drive
    // correct by construction rather than by everyone remembering to check a flag.
    expect(rowsOf(store, OUTBOX_TYPE)).toHaveLength(0);
    expect(engine.pendingMutations()).toHaveLength(0);

    // …and it is visible, with the server's own sentence rather than one this client invented.
    const abandoned = engine.abandoned();
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]!.key).toBe(first.key);
    expect(abandoned[0]!.attempts).toBe(OUTBOX_MAX_SERVER_FAILURES);
    expect(abandoned[0]!.error).toMatchObject({ status: 500, code: "internal", message: "internal error" });

    // The overlay is gone and the surface was told, so nothing is left on screen that no longer
    // exists anywhere. This is the same visible rollback an explicit refusal performs — from the
    // user's side, abandoning IS a refusal.
    expect(notified).toBeGreaterThan(0);
    store.close();
  });

  it("dispatches nothing while a verb is inside its backoff, and the wait doubles", async () => {
    const factory = new IDBFactory();
    const c = clock();
    const w = rig(new FixturesAdapter());
    const store = new IndexedDbMirrorStore({ owner: "acct-backoff", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: c.now });
    await engine.start();

    w.fail(SERVER_500);
    await engine.mutate(VERB);
    expect(w.mutates).toBe(1);

    // Well inside the first backoff: drives happen, the verb is not touched. Without the gate this
    // is the unbounded loop — every drive, for ever.
    for (let i = 0; i < 5; i++) {
      c.advance(OUTBOX_BACKOFF_BASE_MS / 10);
      await engine.syncOnce();
    }
    expect(w.mutates).toBe(1);

    // Past the first backoff: exactly one more attempt.
    c.advance(OUTBOX_BACKOFF_BASE_MS);
    await engine.syncOnce();
    expect(w.mutates).toBe(2);

    // The second wait is longer than the first — a fixed delay would be a slower loop, not a
    // backoff. Just under the doubled interval still dispatches nothing.
    c.advance(OUTBOX_BACKOFF_BASE_MS * 1.5);
    await engine.syncOnce();
    expect(w.mutates).toBe(2);
    store.close();
  });

  it("an offline laptop retries for ever — `network` never spends the ceiling", async () => {
    const factory = new IDBFactory();
    const c = clock();
    const w = rig(new FixturesAdapter());
    const store = new IndexedDbMirrorStore({ owner: "acct-offline", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: c.now });
    await engine.start();

    w.fail(OFFLINE);
    await engine.mutate(VERB);

    for (let i = 0; i < 50; i++) {
      c.advance(OUTBOX_BACKOFF_CAP_MS + 1);
      await engine.syncOnce();
    }

    // Fifty drives, six times the ceiling, and the verb is still queued and still trying. THIS is
    // the assertion that stops the bound from becoming a data-loss feature: a laptop on a train
    // must not lose the mail it wrote in a tunnel.
    expect(w.mutates).toBeGreaterThan(OUTBOX_MAX_SERVER_FAILURES);
    expect(engine.abandoned()).toHaveLength(0);
    expect(rowsOf(store, OUTBOX_TYPE)).toHaveLength(1);
    store.close();
  });

  it.each([
    // No status, as `network` has none: the browser's PUT threw.
    { door: "the browser", shape: {} },
    // The desktop's hosted door, whose own PUT threw: 503 and a named wait, counted all the same.
    { door: "the desktop's hosted door", shape: { status: 503, retryAfterMs: 5_000 } },
  ])("an upload that cannot reach storage spends the ceiling and ends in the abandoned list ($door)", async ({ shape }) => {
    const factory = new IDBFactory();
    const c = clock();
    const w = rig(new FixturesAdapter());
    const store = new IndexedDbMirrorStore({ owner: "acct-staging", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: c.now });
    await engine.start();

    // The API had just answered the mint, so the verb is what fails, and retrying it for ever was
    // the send that never left.
    w.fail(() => new MutationRejectedError("could not upload", { code: "staging_unreachable", retryable: true, ...shape }));
    const first = await engine.mutate(VERB);
    for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES * 3; i++) {
      c.advance(OUTBOX_BACKOFF_CAP_MS + 1);
      await engine.syncOnce();
    }
    expect(w.mutates).toBe(OUTBOX_MAX_SERVER_FAILURES);
    expect(engine.abandoned().map((a) => a.key)).toEqual([first.key]);
    store.close();
  });

  it("a refusal that names its own interval waits that long and spends no patience", async () => {
    const factory = new IDBFactory();
    const c = clock();
    const w = rig(new FixturesAdapter());
    const store = new IndexedDbMirrorStore({ owner: "acct-busy", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: c.now });
    await engine.start();

    w.fail(DB_BUSY);
    await engine.mutate(VERB);

    for (let i = 0; i < 30; i++) {
      c.advance(3_000);          // longer than the server's 2 s, shorter than the base backoff
      await engine.syncOnce();
    }

    // A twenty-minute pool outage must not abandon a single legitimate verb. It also obeys the
    // server's interval rather than the client's: at 3 s per drive it retried on every one, which
    // the 30 s base backoff would have prevented.
    expect(w.mutates).toBeGreaterThan(OUTBOX_MAX_SERVER_FAILURES);
    expect(engine.abandoned()).toHaveLength(0);
    store.close();
  });

  it("the counter survives a kill — a reboot does not hand a poisoned verb a fresh ceiling", async () => {
    const factory = new IDBFactory();
    const c = clock();

    const w1 = rig(new FixturesAdapter());
    const store1 = new IndexedDbMirrorStore({ owner: "acct-persist", factory });
    const e1 = new OhmailEngine({ adapter: w1.adapter, store: store1, now: c.now });
    await e1.start();
    w1.fail(SERVER_500);
    await e1.mutate(VERB);
    // A few failures, then the process dies.
    for (let i = 0; i < 3; i++) {
      c.advance(OUTBOX_BACKOFF_CAP_MS + 1);
      await e1.syncOnce();
    }
    const before = w1.mutates;
    expect(before).toBeGreaterThan(1);
    store1.close();

    // A fresh process over the same storage.
    const w2 = rig(new FixturesAdapter());
    const store2 = new IndexedDbMirrorStore({ owner: "acct-persist", factory });
    const e2 = new OhmailEngine({ adapter: w2.adapter, store: store2, now: c.now });
    w2.fail(SERVER_500);
    await e2.hydrate();
    for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES * 2; i++) {
      c.advance(OUTBOX_BACKOFF_CAP_MS + 1);
      await e2.syncOnce();
    }

    // The two sessions TOGETHER spend one ceiling. An in-memory counter would give every boot a
    // fresh eight, which for a laptop that sleeps is indistinguishable from no bound at all.
    expect(before + w2.mutates).toBe(OUTBOX_MAX_SERVER_FAILURES);
    expect(e2.abandoned()).toHaveLength(1);
    store2.close();
  });

  it("a `v: 1` record written by the previous build still restores and still replays", async () => {
    const factory = new IDBFactory();
    const c = clock();
    const store = new IndexedDbMirrorStore({ owner: "acct-v1", factory });
    const w = rig(new FixturesAdapter());
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: c.now });
    await engine.start();

    // Exactly what the previous build persisted — no `attempts`, no `nextAt`, no `lastError`.
    await store.putLocal(OUTBOX_TYPE, "legacy-1", {
      v: 1, id: "legacy-1", key: "legacy-key-1", n: 1, at: c.now().getTime() - 1_000,
      mutation: VERB,
    });
    store.close();

    const store2 = new IndexedDbMirrorStore({ owner: "acct-v1", factory });
    const w2 = rig(new FixturesAdapter());
    const e2 = new OhmailEngine({ adapter: w2.adapter, store: store2, now: c.now });
    await e2.hydrate();
    await e2.syncOnce();

    // The upgrade must not orphan a verb the user already expressed. A gate demanding `v === 2`
    // would leave this on disk, valid, and never looked at again — the user's unsent work lost by
    // the very record type that exists to make it durable.
    expect(w2.mutates).toBeGreaterThan(0);
    expect(rowsOf(store2, OUTBOX_TYPE)).toHaveLength(0);
    store2.close();
  });

  it("a modelled send wait — `send_queued` / `send_in_flight` — spends none of the ceiling", async () => {
    const factory = new IDBFactory();
    const c = clock();
    const w = rig(new FixturesAdapter());
    const store = new IndexedDbMirrorStore({ owner: "acct-sendwait", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: c.now });
    await engine.start();

    // The gated send's own vocabulary: the server HAS the reservation and an attempt is live.
    // These arrive with an ordinary numeric status and no `Retry-After`, so they looked exactly
    // like unmodelled faults — and eight of them would abandon a send whose SMTP submission may
    // still be running, unlock the composer, and let the next press mint a FRESH key. That is a
    // second delivery of a message the first attempt may already have sent.
    w.fail(() => new MutationRejectedError("still going", {
      status: 409, code: "send_in_flight", retryable: true,
    }));
    await engine.mutate(VERB);
    for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES * 3; i++) {
      c.advance(OUTBOX_BACKOFF_CAP_MS + 1);
      await engine.syncOnce();
    }
    expect(engine.abandoned()).toHaveLength(0);
    expect(w.mutates).toBeGreaterThan(OUTBOX_MAX_SERVER_FAILURES);
    store.close();
  });

  it("a duplicate refused while the FIRST attempt is pending spends none of the ceiling", async () => {
    const factory = new IDBFactory();
    const c = clock();
    const w = rig(new FixturesAdapter());
    const store = new IndexedDbMirrorStore({ owner: "acct-dupwait", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: c.now });
    await engine.start();

    /**
     * THE ARITHMETIC DECIDED THE OUTCOME, WHICH IS WHY THIS IS ITS OWN CASE.
     *
     * A duplicate refused while the first attempt is still `pending` is retryable ON PURPOSE: the
     * server cannot say yet how that attempt ended, and the client keeps asking until it can. But
     * the ceiling is eight SERVER-ANSWERED failures, and at the web retry cadence eight arrive in
     * about 255 seconds — while the server's own stale recovery does not run until ten minutes
     * (`SEND_STALE_AFTER_MS`). So the verb was abandoned BEFORE the thing it was waiting for could
     * happen, and a first attempt that then failed left a reclaimable claim nobody ever retried.
     * The message was lost with every part working as designed.
     *
     * A wait shorter than the wait it is waiting on is not a wait.
     */
    w.fail(() => new MutationRejectedError("already being sent", {
      status: 409, code: "duplicate_send", retryable: true,
      details: { firstSend: { status: "pending" } },
    }));
    await engine.mutate(VERB);
    for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES * 3; i++) {
      c.advance(OUTBOX_BACKOFF_CAP_MS + 1);
      await engine.syncOnce();
    }
    expect(engine.abandoned(), "the send must still be waiting when recovery becomes possible")
      .toHaveLength(0);
    expect(w.mutates).toBeGreaterThan(OUTBOX_MAX_SERVER_FAILURES);
    store.close();
  });

  it("abandoned records ride through a 410 reset, like the live queue does", async () => {
    const factory = new IDBFactory();
    const c = clock();
    const w = rig(new FixturesAdapter());
    const store = new IndexedDbMirrorStore({ owner: "acct-410", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: c.now });
    await engine.start();

    w.fail(SERVER_500);
    const first = await engine.mutate(VERB);
    for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES * 2; i++) {
      c.advance(OUTBOX_BACKOFF_CAP_MS + 1);
      await engine.syncOnce();
    }
    expect(engine.abandoned()).toHaveLength(1);
    w.fail(null);

    // A REAL 410, through the drive — the path that snapshots and writes back. Calling
    // `resetForBootstrap()` by hand would prove nothing about the engine's recovery, which is
    // where the omission was.
    //
    // The rule the live outbox already rode through on: a 410 is a statement about the CURSOR,
    // never about the user's intents. The abandoned list was being wiped with the mirror, which
    // silently deleted the one class of intent nothing else will ever deliver.
    w.failNextSync(new CursorExpiredError("cursor expired"));
    await engine.syncOnce();

    expect(engine.abandoned()).toHaveLength(1);
    expect(engine.abandoned()[0]!.key).toBe(first.key);
    store.close();
  });

  it("a superseded record refuses Try again rather than overwriting the newer intent", async () => {
    const factory = new IDBFactory();
    const c = clock();
    const w = rig(new FixturesAdapter());
    const store = new IndexedDbMirrorStore({ owner: "acct-supersede", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: c.now });
    await engine.start();

    w.fail(SERVER_500);
    const first = await engine.mutate({ kind: "triage_set", messageId: "petra", state: "reply_later" });
    for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES * 2; i++) {
      c.advance(OUTBOX_BACKOFF_CAP_MS + 1);
      await engine.syncOnce();
    }
    expect(engine.abandoned()).toHaveLength(1);
    expect(engine.abandoned()[0]!.superseded).toBe(false);

    // A NEWER verb for the same target lands. Replaying the abandoned one would put the older
    // state back over it — the user asked to retry something they could not see was stale.
    w.fail(null);
    await engine.mutate({ kind: "triage_set", messageId: "petra", state: "none" });

    expect(engine.abandoned()[0]!.superseded).toBe(true);
    expect((await engine.retryAbandoned(first.id)).error?.code).toBe("outbox_superseded");
    // MARKED, NOT DELETED: throwing it away silently is the failure this collection prevents.
    expect(engine.abandoned()).toHaveLength(1);
    store.close();
  });

  it("Try again re-queues under the ORIGINAL key, and Discard removes the record", async () => {
    const factory = new IDBFactory();
    const c = clock();
    const w = rig(new FixturesAdapter());
    const store = new IndexedDbMirrorStore({ owner: "acct-retry", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: c.now });
    await engine.start();

    w.fail(SERVER_500);
    const first = await engine.mutate(VERB);
    for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES * 2; i++) {
      c.advance(OUTBOX_BACKOFF_CAP_MS + 1);
      await engine.syncOnce();
    }
    expect(engine.abandoned()).toHaveLength(1);

    // The world is repaired; the person presses Try again.
    w.fail(null);
    // Returns the engine's own `MutationResult` now, not a boolean — the surfaces need the
    // terminal answer, and a retried send's `send_unverified` was being said to nobody.
    expect((await engine.retryAbandoned(first.id)).status).not.toBe("rolled_back");
    await engine.syncOnce();

    // THE KEY IS THE ORIGINAL ONE. If the failed attempt actually committed and only its answer
    // was lost, replaying the same key replays the stored response; a fresh key would send a
    // genuine duplicate — a second draft, or a second send.
    expect(engine.abandoned()).toHaveLength(0);
    expect(rowsOf(store, OUTBOX_ABANDONED_TYPE)).toHaveLength(0);
    expect(rowsOf(store, OUTBOX_TYPE)).toHaveLength(0);

    // And Discard, on a second abandoned verb, simply removes it.
    w.fail(SERVER_500);
    const second = await engine.mutate({ kind: "triage_set", messageId: "petra", state: "reply_later" });
    for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES * 2; i++) {
      c.advance(OUTBOX_BACKOFF_CAP_MS + 1);
      await engine.syncOnce();
    }
    expect(engine.abandoned()).toHaveLength(1);
    await engine.discardAbandoned(second.id);
    expect(engine.abandoned()).toHaveLength(0);
    store.close();
  });
});
