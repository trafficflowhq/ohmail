import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  CursorExpiredError,
  DEMO_NOW,
  FixturesAdapter,
  IndexedDbMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  OUTBOX_ENTRY_VERSION,
  OUTBOX_TYPE,
  SqlMirrorStore,
  type EngineAdapter,
  type EngineDraft,
  type EngineMessage,
  type EngineMutation,
  type MirrorStore,
  type SyncChange,
} from "@ohmail/client-engine";
import { sqlWorld } from "./helpers/node-sql-executor.js";

/**
 * THE DURABLE OUTBOX — INSTANT-ARCH §8 stage 1's proof obligations, held down.
 *
 * The three claims under test, each of which was FALSE before the slice:
 *
 *  1. KILL-RESTART: a verb queued by a network failure survives the process. The queue used to
 *     be `private readonly queue: PendingMutation[]` and nothing else — mark ten messages read
 *     on a flaky connection, close the laptop, and ten verbs evaporated (INSTANT-ARCH §4.2
 *     seam 1, "the single largest structural contributor" to actions-don't-stick). Now every
 *     verb is persisted in the mirror store before its POST, restores with the mirror, replays
 *     under its ORIGINAL Idempotency-Key, and its optimistic overlay is standing in the very
 *     first post-hydrate read — the boot render is continuous with the killed session.
 *
 *  2. BOOT-DRAIN ORDERING: the restored outbox replays BEFORE the first sync page is read, so
 *     the drain that follows was issued after every replayed POST returned and carries every
 *     echo — one round of requests to full convergence, no overlay left hanging.
 *
 *  3. THE OVERLAY OUTLIVES A FAILED RECONCILE DRAIN (seam 2, `engine.ts`' old residual): a
 *     confirmed write whose post-confirm drain died used to drop its overlay anyway and the row
 *     REVERTED on screen until the next poll — the reported "mark them read multiple times".
 *     Now the overlay stands until a drain that began after the POST returned completes, and
 *     retires only then (or on an explicit refusal, which rolls back visibly).
 *
 * Two persistence engines are exercised — fake-indexeddb (the webapp's store) and node:sqlite
 * behind the `SqlExecutor` seam (the mobile store, and the seam the desktop's PGlite adoption
 * binds in stage 7) — because durability is a claim about what is on disk, not about the
 * engine's memory.
 */

/** Let every pending microtask AND the macrotask queue run. */
const tick = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });

const RETRYABLE = () => new MutationRejectedError("network failure: connection reset", {
  code: "network", retryable: true,
});

interface Recorded {
  op: "mutate" | "sync";
  kind?: string;
  key?: string;
}

interface Wire {
  adapter: EngineAdapter;
  calls: Recorded[];
  /** Throw this from the NEXT matching mutate (null clears). */
  setFailMutate: (fn: ((m: EngineMutation) => Error | null) | null) => void;
  /** Throw this from the NEXT sync request, once. */
  failNextSync: (err: Error) => void;
  /** Every mutate from now on HANGS — a request in flight when the process dies. */
  hangMutates: () => void;
  /** The NEXT mutate APPLIES server-side and then loses its answer (retryable network error). */
  loseNextMutate: () => void;
  /** The NEXT mutate blocks until the returned release is called, then applies normally. */
  gateNextMutate: () => () => void;
}

/**
 * The FixturesAdapter behind a controllable wire. `mutate` answers `{changes: [], seq}` — the
 * NO-ECHO contract most real routes have (`http-adapter.ts`), which is the shape that forces
 * the engine through the reconcile-drain path these tests are about. A mutate failure is
 * raised BEFORE the inner world sees the verb, exactly like a request that never reached the
 * server.
 */
function wire(inner: FixturesAdapter): Wire {
  const calls: Recorded[] = [];
  let failMutate: ((m: EngineMutation) => Error | null) | null = null;
  let syncFailure: Error | null = null;
  let hangMutate = false;
  let loseNext = false;
  let gate: { open: Promise<void>; release: () => void } | null = null;
  const adapter: EngineAdapter = {
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: () => inner.fetchBody(),
    async sync(params) {
      calls.push({ op: "sync" });
      if (syncFailure) {
        const err = syncFailure;
        syncFailure = null;
        throw err;
      }
      return inner.sync(params);
    },
    async mutate(m, o) {
      calls.push({ op: "mutate", kind: m.kind, key: o.idempotencyKey });
      if (hangMutate) return new Promise<never>(() => { /* the process dies around this */ });
      if (gate) {
        const g = gate;
        gate = null;
        await g.open; // …the slow request: in the air until the test releases it
      }
      if (loseNext) {
        loseNext = false;
        await inner.mutate(m, o); // the server COMMITS…
        throw RETRYABLE();        // …and the answer dies on the way back
      }
      const err = failMutate?.(m);
      if (err) throw err;
      const out = await inner.mutate(m, o);
      return { changes: [], seq: out.seq };
    },
  };
  return {
    adapter,
    calls,
    setFailMutate: (fn) => { failMutate = fn; },
    failNextSync: (err) => { syncFailure = err; },
    hangMutates: () => { hangMutate = true; },
    loseNextMutate: () => { loseNext = true; },
    gateNextMutate: () => {
      let release!: () => void;
      const open = new Promise<void>((r) => { release = r; });
      gate = { open, release };
      return release;
    },
  };
}

const outboxRows = (store: MirrorStore) => store.entries<{ key: string }>(OUTBOX_TYPE);

const giuliaUnread = (engine: OhmailEngine): boolean | undefined =>
  engine.read().get<EngineMessage>("message", "giulia")?.unread;

/** Flip giulia back to unread in the MIRROR at a fresh seq — the overlay-mask probe. */
async function flipGiuliaUnreadInMirror(engine: OhmailEngine): Promise<void> {
  const msg = engine.store.get<EngineMessage>("message", "giulia")!;
  const change: SyncChange = {
    type: "message", op: "update", id: "giulia", seq: engine.store.maxSeq() + 1_000,
    updatedAt: msg.updatedAt, entity: { ...msg, unread: true },
  };
  await engine.store.applyChanges([change]);
}

describe("durable outbox — kill-restart (fake-indexeddb, the webapp store)", () => {
  it("a verb queued by a network failure survives the kill: boot render carries it, it replays under the SAME key before the first sync, and the mirror converges", async () => {
    const factory = new IDBFactory();

    // ── session 1: bootstrap, then a verb the network refuses ──────────────────────────────
    const w1 = wire(new FixturesAdapter());
    const store1 = new IndexedDbMirrorStore({ owner: "acct-outbox", factory });
    const e1 = new OhmailEngine({ adapter: w1.adapter, store: store1, now: () => DEMO_NOW });
    await e1.start();
    expect(giuliaUnread(e1)).toBe(true);

    w1.setFailMutate(() => RETRYABLE());
    const res = await e1.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    expect(res.status).toBe("queued");
    expect(giuliaUnread(e1)).toBe(false); // the intent stands on screen
    store1.close();
    // The kill: nothing else runs in session 1.

    // ── session 2: a fresh process over the same browser storage ───────────────────────────
    const w2 = wire(new FixturesAdapter());
    const store2 = new IndexedDbMirrorStore({ owner: "acct-outbox", factory });
    const e2 = new OhmailEngine({ adapter: w2.adapter, store: store2, now: () => DEMO_NOW });

    await e2.hydrate();
    // THE BOOT RENDER IS CONTINUOUS: before any network, the restored overlay already shows
    // the verb's effect — never a flash of the pre-verb state.
    expect(w2.calls).toHaveLength(0);
    expect(giuliaUnread(e2)).toBe(false);

    await e2.syncOnce();
    // Boot-drain ordering: the replayed POST precedes the first page read…
    expect(w2.calls[0]).toMatchObject({ op: "mutate", kind: "mark_seen", key: res.key });
    expect(w2.calls[1]?.op).toBe("sync");
    // …and one drive converges everything: the echo is in the MIRROR (not just the overlay),
    // the durable entry is retired, and the queue is empty.
    expect(store2.get<EngineMessage>("message", "giulia")?.unread).toBe(false);
    expect(outboxRows(store2)).toHaveLength(0);
    expect(e2.pendingMutations()).toHaveLength(0);
    store2.close();
  });

  it("a kill MID-FLIGHT — the POST issued, no answer yet — still delivers on the next boot", async () => {
    // The pagehide shape: `commitPendingRead` dispatches during `pagehide`, the browser kills
    // the tab before the fetch settles, and the verb's ONLY survival path is the durable write
    // `mutate()` makes BEFORE the wire. This is the case the retryable-queue path can never
    // cover, because the failure callback also dies with the process.
    const factory = new IDBFactory();
    const w1 = wire(new FixturesAdapter());
    const store1 = new IndexedDbMirrorStore({ owner: "acct-midflight", factory });
    const e1 = new OhmailEngine({ adapter: w1.adapter, store: store1, now: () => DEMO_NOW });
    await e1.start();

    // The POST goes out and never answers — then the process dies around it.
    w1.hangMutates();
    void e1.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    /**
     * A BOUNDED WAIT, NOT A SINGLE TICK — and the reason is a real change in the store, not a
     * flake. The outbox used to be written with `putLocal`, which publishes to memory
     * SYNCHRONOUSLY and then flushes; one tick was always enough to see it. It is now written
     * with `commitLocal`, which publishes only once its storage transaction has committed —
     * strictly more durable, and strictly later to become visible here. Under a loaded full-suite
     * run one tick stopped being enough, and the failure read as "the entry was not durable
     * before the wire", which is the opposite of what had happened.
     *
     * The assertion is unchanged. Only the wait is: it now waits for the write it is asserting
     * about, instead of assuming the write was synchronous.
     */
    for (let i = 0; i < 50 && outboxRows(store1).length === 0; i++) await tick();
    expect(outboxRows(store1), "the entry must be durable BEFORE the wire").toHaveLength(1);
    store1.close();

    const w2 = wire(new FixturesAdapter());
    const store2 = new IndexedDbMirrorStore({ owner: "acct-midflight", factory });
    const e2 = new OhmailEngine({ adapter: w2.adapter, store: store2, now: () => DEMO_NOW });
    await e2.hydrate();
    expect(giuliaUnread(e2)).toBe(false); // the boot render carries the killed session's intent
    await e2.syncOnce();
    expect(w2.calls[0]?.op).toBe("mutate");
    expect(store2.get<EngineMessage>("message", "giulia")?.unread).toBe(false);
    expect(outboxRows(store2)).toHaveLength(0);
    store2.close();
  });

  it("TWO queued verbs replay oldest-first, keys preserved — order is user order", async () => {
    const factory = new IDBFactory();
    const w1 = wire(new FixturesAdapter());
    const store1 = new IndexedDbMirrorStore({ owner: "acct-order", factory });
    const e1 = new OhmailEngine({ adapter: w1.adapter, store: store1, now: () => DEMO_NOW });
    await e1.start();

    w1.setFailMutate(() => RETRYABLE());
    const first = await e1.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    const second = await e1.mutate({ kind: "triage_set", messageId: "petra", state: "reply_later" });
    expect(first.status).toBe("queued");
    expect(second.status).toBe("queued");
    store1.close();

    const w2 = wire(new FixturesAdapter());
    const store2 = new IndexedDbMirrorStore({ owner: "acct-order", factory });
    const e2 = new OhmailEngine({ adapter: w2.adapter, store: store2, now: () => DEMO_NOW });
    await e2.hydrate();
    await e2.syncOnce();

    const mutates = w2.calls.filter((c) => c.op === "mutate");
    expect(mutates.map((c) => ({ kind: c.kind, key: c.key }))).toEqual([
      { kind: "mark_seen", key: first.key },
      { kind: "triage_set", key: second.key },
    ]);
    // Both POSTs returned before the drain's first page was read.
    expect(w2.calls.findIndex((c) => c.op === "sync")).toBe(2);
    expect(outboxRows(store2)).toHaveLength(0);
    store2.close();
  });

  it("a restored verb the server REFUSES rolls back visibly, once — and its entry is gone", async () => {
    const factory = new IDBFactory();
    const w1 = wire(new FixturesAdapter());
    const store1 = new IndexedDbMirrorStore({ owner: "acct-refusal", factory });
    const e1 = new OhmailEngine({ adapter: w1.adapter, store: store1, now: () => DEMO_NOW });
    await e1.start();
    w1.setFailMutate(() => RETRYABLE());
    await e1.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    store1.close();

    const w2 = wire(new FixturesAdapter());
    w2.setFailMutate(() => new MutationRejectedError("no such message", { status: 422, code: "validation_failed" }));
    const store2 = new IndexedDbMirrorStore({ owner: "acct-refusal", factory });
    const e2 = new OhmailEngine({ adapter: w2.adapter, store: store2, now: () => DEMO_NOW });
    await e2.hydrate();
    expect(giuliaUnread(e2)).toBe(false); // restored intent, on screen

    await e2.syncOnce();
    // The refusal is honest: the local effect rolled back (the row is unread again), and the
    // verb does not lurk anywhere to replay a third time.
    expect(giuliaUnread(e2)).toBe(true);
    expect(outboxRows(store2)).toHaveLength(0);
    expect(e2.pendingMutations()).toHaveLength(0);
    store2.close();
  });

  it("confirmed and refused verbs leave no durable entry behind", async () => {
    const factory = new IDBFactory();
    const w = wire(new FixturesAdapter());
    const store = new IndexedDbMirrorStore({ owner: "acct-clean", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: () => DEMO_NOW });
    await engine.start();

    const ok = await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    expect(ok.status).toBe("confirmed");
    expect(outboxRows(store)).toHaveLength(0);

    w.setFailMutate(() => new MutationRejectedError("nope", { status: 403 }));
    const refused = await engine.mutate({ kind: "triage_set", messageId: "petra", state: "reply_later" });
    expect(refused.status).toBe("rolled_back");
    expect(outboxRows(store)).toHaveLength(0);
    store.close();
  });

  it("a 410 mid-drive does not take the persisted verbs with it — every outbox row rides through the reset", async () => {
    const factory = new IDBFactory();
    const w = wire(new FixturesAdapter());
    const store = new IndexedDbMirrorStore({ owner: "acct-410", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: () => DEMO_NOW });
    await engine.start();

    w.setFailMutate(() => RETRYABLE());
    const res = await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    expect(res.status).toBe("queued");
    expect(outboxRows(store)).toHaveLength(1);
    // A second row the QUEUE does not know about — an entry a newer build wrote. The reset
    // must carry it too: re-persisting only `this.queue` would silently eat it.
    await store.putLocal(OUTBOX_TYPE, "foreign-shape", {
      v: 2, id: "foreign-shape", key: "k-f", n: 0, at: 1, mutation: { kind: "future_verb" },
    });

    // The next drive 410s: the reset wipes the whole store, durable entries included.
    w.failNextSync(new CursorExpiredError());
    await engine.syncOnce();
    expect(outboxRows(store), "the 410 reset must not eat the durable outbox").toHaveLength(2);
    expect(engine.pendingMutations()).toHaveLength(1);

    // The network returns. The queued verb belongs to its OWNER — a drive must not consume it
    // (see the ownership test below); flushPending delivers it under the original key.
    w.setFailMutate(null);
    const flushed = await engine.flushPending();
    expect(flushed[0]).toMatchObject({ key: res.key, status: "confirmed" });
    expect(outboxRows(store)).toHaveLength(1); // the foreign-shape row alone, still waiting
    expect(store.get<EngineMessage>("message", "giulia")?.unread).toBe(false);
    store.close();
  });

  it("a SAME-SESSION owner-settled verb (a draft CREATE) is never consumed by a drive — flushPending gets the result", async () => {
    // The ownership rule: useMailSend's lock and a compose's entityId adoption settle from
    // flushPending's returned results. An automatic drive that replayed one of those entries
    // would discard the result its caller waits on — a delivered send whose composer never
    // unlocks, a created draft whose autosave mints a twin under a fresh key.
    const factory = new IDBFactory();
    const w = wire(new FixturesAdapter());
    const store = new IndexedDbMirrorStore({ owner: "acct-owner", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: () => DEMO_NOW });
    await engine.start();

    w.setFailMutate(() => RETRYABLE());
    const res = await engine.mutate({
      kind: "draft_save", draftId: null, mailboxId: "mb-milabrunner",
      inReplyToMessageId: null, subject: "draft", body: "…", to: [], cc: [], bcc: [],
    });
    expect(res.status).toBe("queued");
    const attemptsBefore = w.calls.filter((c) => c.op === "mutate").length;

    w.setFailMutate(null);
    await engine.syncOnce(); // a poll drive — must NOT touch a verb its owner settled
    expect(w.calls.filter((c) => c.op === "mutate")).toHaveLength(attemptsBefore);
    expect(engine.pendingMutations()).toHaveLength(1);

    const flushed = await engine.flushPending();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toMatchObject({ key: res.key, status: "confirmed" });
    expect(outboxRows(store)).toHaveLength(0);
    store.close();
  });

  it("a create restored after a kill paints its row with its key; one taken back before the kill is not replayed", async () => {
    // A door binds a waiting create by the key on its row: a restored row without it binds a local id.
    const factory = new IDBFactory();
    const create = (body: string): EngineMutation => ({
      kind: "draft_save", draftId: null, mailboxId: "mb-milabrunner",
      inReplyToMessageId: null, subject: "draft", body, to: [], cc: [], bcc: [],
    });
    const w1 = wire(new FixturesAdapter());
    const store1 = new IndexedDbMirrorStore({ owner: "acct-create-key", factory });
    const e1 = new OhmailEngine({ adapter: w1.adapter, store: store1, now: () => DEMO_NOW });
    await e1.start();
    w1.setFailMutate(() => RETRYABLE());
    const kept = await e1.mutate(create("kept words"));
    const taken = await e1.mutate(create("taken words"));
    expect(await e1.withdrawQueued(taken.key)).toBe("withdrawn");
    store1.close();

    const w2 = wire(new FixturesAdapter());
    w2.setFailMutate(() => RETRYABLE());
    const store2 = new IndexedDbMirrorStore({ owner: "acct-create-key", factory });
    const e2 = new OhmailEngine({ adapter: w2.adapter, store: store2, now: () => DEMO_NOW });
    await e2.start();
    const rows = e2.read().list<EngineDraft>("draft").filter((d) => d.body === "kept words" || d.body === "taken words");
    expect(rows.map((d) => [d.body, d.pendingCreate]), "the restored create's row lost its key").toEqual([["kept words", kept.key]]);
    expect(e2.pendingCreateOf(rows[0]!.id)).toBe(kept.key);
    w2.setFailMutate(null);
    await e2.flushPending();
    await tick();
    expect(w2.calls.filter((c) => c.op === "mutate").map((c) => c.key), "a create taken back before the kill was replayed")
      .not.toContain(taken.key);
    store2.close();
  });

  it("a SAME-SESSION unowned verb (mark_seen) IS retried by the next drive — nobody else would ever flush it", async () => {
    // The other half of ownership: the webapp dispatches mark_seen fire-and-forget and calls
    // flushPending only around sends, so a verb queued by a blip that waited for an owner
    // would wait until reload — user-always-wins demands convergence, and the scheduler's
    // ordinary drives are the retry cadence.
    const factory = new IDBFactory();
    const w = wire(new FixturesAdapter());
    const store = new IndexedDbMirrorStore({ owner: "acct-unowned", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: () => DEMO_NOW });
    await engine.start();

    w.setFailMutate(() => RETRYABLE());
    const res = await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    expect(res.status).toBe("queued");

    w.setFailMutate(null);
    await engine.syncOnce(); // the next poll delivers it, before its drain reads a page
    const replayed = w.calls.filter((c) => c.op === "mutate" && c.key === res.key);
    expect(replayed.length).toBeGreaterThanOrEqual(2); // the failed attempt + the drive's
    expect(engine.pendingMutations()).toHaveLength(0);
    expect(outboxRows(store)).toHaveLength(0);
    expect(store.get<EngineMessage>("message", "giulia")?.unread).toBe(false);
    store.close();
  });

  it("a timed-out replay stops the BATCH — an entry behind a hung one cannot overtake it", async () => {
    // Order is the contract: mark-read then mark-unread must land in that order. If the first
    // restored request hangs past the deadline and later commits, dispatching the second
    // meanwhile could reverse the final state on the server — so the timeout defers the rest
    // of the batch to the next drive instead of racing past the hung verb.
    const factory = new IDBFactory();
    const w1 = wire(new FixturesAdapter());
    const store1 = new IndexedDbMirrorStore({ owner: "acct-order2", factory });
    const e1 = new OhmailEngine({ adapter: w1.adapter, store: store1, now: () => DEMO_NOW });
    await e1.start();
    w1.setFailMutate(() => RETRYABLE());
    // Two DIFFERENT targets: same-target pairs are retired by supersession before they can
    // ever race — this test is about order between verbs that both still stand.
    await e1.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    await e1.mutate({ kind: "triage_set", messageId: "petra", state: "reply_later" });
    store1.close();

    const w2 = wire(new FixturesAdapter());
    w2.hangMutates();
    const store2 = new IndexedDbMirrorStore({ owner: "acct-order2", factory });
    const e2 = new OhmailEngine({
      adapter: w2.adapter, store: store2, now: () => DEMO_NOW, outboxReplayDeadlineMs: 40,
    });
    await e2.hydrate();
    await e2.syncOnce();

    // Exactly ONE mutate went out (the hung first); the second waited its turn; the drain ran.
    expect(w2.calls.filter((c) => c.op === "mutate")).toHaveLength(1);
    expect(w2.calls[0]).toMatchObject({ op: "mutate", kind: "mark_seen" });
    expect(w2.calls.some((c) => c.op === "sync")).toBe(true);
    expect(e2.pendingMutations()).toHaveLength(1); // the deferred second, still owed in order
    store2.close();
  });

  it("an unkeyed CREATE past the server's 24h dedupe horizon is dropped, not replayed — state verbs replay at any age", async () => {
    const factory = new IDBFactory();
    const store1 = new IndexedDbMirrorStore({ owner: "acct-ttl", factory });
    await store1.load();
    const dayAndMore = DEMO_NOW.getTime() - (24 * 60 * 60 * 1000 + 60_000);
    // A rule_create expressed 24h+ ago: the server's idempotency record has expired, rules
    // have no uniqueness constraint, and replaying would mint a silent duplicate.
    await store1.putLocal(OUTBOX_TYPE, "old-create", {
      v: 1, id: "old-create", key: "k-old-create", n: 0, at: dayAndMore,
      mutation: { kind: "rule_create", scope: "sender", match: "x@example.com", destination: "INBOX" },
    });
    // A mark_seen of the same age: absolute-valued, converges on re-application — replays.
    await store1.putLocal(OUTBOX_TYPE, "old-state", {
      v: 1, id: "old-state", key: "k-old-state", n: 1, at: dayAndMore,
      mutation: { kind: "mark_seen", messageIds: ["giulia"], unread: false },
    });
    store1.close();

    const w = wire(new FixturesAdapter());
    const store2 = new IndexedDbMirrorStore({ owner: "acct-ttl", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store: store2, now: () => DEMO_NOW });
    await engine.hydrate();
    await engine.syncOnce();

    const mutates = w.calls.filter((c) => c.op === "mutate");
    expect(mutates.map((c) => c.kind)).toEqual(["mark_seen"]);
    expect(outboxRows(store2)).toHaveLength(0); // the stale create was dropped, the state verb delivered
    store2.close();
  });

  it("a CONFIRMED verb whose echo never reached the mirror survives a kill — the entry outlives the confirmation", async () => {
    // The kill window: POST confirmed, the reconcile drain failed, the
    // process dies before any drain succeeds. Dropping the durable entry at confirm time would
    // restart into the stale pre-verb mirror with nothing to re-apply — so the entry rides
    // until the sweep proves the echo landed, and this restart re-applies AND re-delivers
    // under the original key (idempotent server-side).
    const factory = new IDBFactory();
    const w1 = wire(new FixturesAdapter());
    const store1 = new IndexedDbMirrorStore({ owner: "acct-echo", factory });
    const e1 = new OhmailEngine({ adapter: w1.adapter, store: store1, now: () => DEMO_NOW });
    await e1.start();

    w1.failNextSync(new Error("the network died right after the POST"));
    const res = await e1.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    expect(res.status).toBe("confirmed");
    expect(outboxRows(store1), "the confirmed-awaiting-echo entry must persist").toHaveLength(1);
    store1.close(); // the kill, before any successful drain

    const w2 = wire(new FixturesAdapter());
    const store2 = new IndexedDbMirrorStore({ owner: "acct-echo", factory });
    const e2 = new OhmailEngine({ adapter: w2.adapter, store: store2, now: () => DEMO_NOW });
    await e2.hydrate();
    expect(giuliaUnread(e2)).toBe(false); // the boot render still carries the verb
    await e2.syncOnce();
    expect(w2.calls[0]).toMatchObject({ op: "mutate", key: res.key });
    expect(store2.get<EngineMessage>("message", "giulia")?.unread).toBe(false);
    expect(outboxRows(store2)).toHaveLength(0);
    store2.close();
  });

  it("a restored verb's optimistic effects are rebuilt at the verb's OWN moment, not the restart's", async () => {
    const factory = new IDBFactory();
    const expressedAt = DEMO_NOW.getTime() - 60 * 60 * 1000; // an hour before the restart
    // Session 1 bootstraps (the persisted mirror holds the reads feed the anchor lives in),
    // then a leave-commit is expressed and the process dies with it queued.
    const w1 = wire(new FixturesAdapter());
    const store1 = new IndexedDbMirrorStore({ owner: "acct-clock", factory });
    const e1 = new OhmailEngine({ adapter: w1.adapter, store: store1, now: () => new Date(expressedAt) });
    await e1.start();
    w1.setFailMutate(() => RETRYABLE());
    await e1.mutate({ kind: "feed_mark_seen", view: "reads", messageIds: [], upToId: "f1" });
    store1.close();

    const w2 = wire(new FixturesAdapter());
    const store2 = new IndexedDbMirrorStore({ owner: "acct-clock", factory });
    const engine = new OhmailEngine({ adapter: w2.adapter, store: store2, now: () => DEMO_NOW });
    await engine.hydrate();

    // The restored waterline stamps the DEPARTURE the reader actually took, an hour ago —
    // not the boot. (A leave-commit restored the next morning must not claim the reader was
    // here at breakfast.)
    const meta = engine.read().get<{ at?: string }>("view_meta", "reads_waterline");
    expect(meta?.at).toBe(new Date(expressedAt).toISOString());
    store2.close();
  });

  it("an entry whose shape this build does not recognise is left in place and NOT replayed", async () => {
    const factory = new IDBFactory();
    const store1 = new IndexedDbMirrorStore({ owner: "acct-future", factory });
    await store1.load();
    // DERIVED, not spelled. This sentinel means "one version past whatever ships today", and it was
    // a literal for two rounds: it read `v: 2` until the give-up ceiling made 2 current, then `v: 3`
    // until the lifecycle work made 3 current. Each time the guard silently inverted into asserting
    // that the CURRENT shape is unrecognised — the opposite of its claim, and green in between.
    await store1.putLocal(OUTBOX_TYPE, "from-the-future", {
      v: OUTBOX_ENTRY_VERSION + 1,
      id: "from-the-future", key: "k-future", n: 0, at: 1, mutation: { kind: "verb_this_build_never_heard_of" },
    });
    store1.close();

    const w = wire(new FixturesAdapter());
    const store2 = new IndexedDbMirrorStore({ owner: "acct-future", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store: store2, now: () => DEMO_NOW });
    await engine.hydrate();
    await engine.syncOnce();

    expect(w.calls.filter((c) => c.op === "mutate")).toHaveLength(0);
    // The verb WAITS for a build that understands it rather than being dropped or mis-sent.
    expect(outboxRows(store2)).toHaveLength(1);
    store2.close();
  });
});

describe("durable outbox — the boot replay cannot hold the sync hostage", () => {
  it("one hung restored request stops being awaited at the deadline, and the drain still runs", async () => {
    const factory = new IDBFactory();
    const w1 = wire(new FixturesAdapter());
    const store1 = new IndexedDbMirrorStore({ owner: "acct-hang", factory });
    const e1 = new OhmailEngine({ adapter: w1.adapter, store: store1, now: () => DEMO_NOW });
    await e1.start();
    w1.setFailMutate(() => RETRYABLE());
    await e1.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    store1.close();

    // The restart's network half-opens: the replayed POST goes out and never answers. The
    // replay runs inside the engine's single-flight, so an unbounded await here would mean no
    // bootstrap and no sync for the whole session — the deadline lets the drain proceed while
    // the in-flight dispatch keeps owning its entry.
    const w2 = wire(new FixturesAdapter());
    w2.hangMutates();
    const store2 = new IndexedDbMirrorStore({ owner: "acct-hang", factory });
    const e2 = new OhmailEngine({
      adapter: w2.adapter, store: store2, now: () => DEMO_NOW, outboxReplayDeadlineMs: 40,
    });
    await e2.hydrate();
    await e2.syncOnce(); // must complete: the deadline fires, the drain runs

    expect(w2.calls.filter((c) => c.op === "sync").length).toBeGreaterThanOrEqual(1);
    // The verb is not lost: its entry is still persisted (the hung dispatch owns it, and the
    // next boot restores it again), and the overlay still carries the intent on screen.
    expect(outboxRows(store2)).toHaveLength(1);
    expect(giuliaUnread(e2)).toBe(false);
    store2.close();
  });
});

describe("durable outbox — kill-restart (node:sqlite, the mobile store)", () => {
  it("the mobile construction order — store loaded BEFORE the engine — restores through restoreOutbox()", async () => {
    const world = sqlWorld();

    const w1 = wire(new FixturesAdapter());
    const store1 = new SqlMirrorStore({ owner: "origin|acct-m", open: world.open });
    await store1.load();
    const e1 = new OhmailEngine({ adapter: w1.adapter, store: store1, now: () => DEMO_NOW });
    e1.restoreOutbox();
    await e1.syncOnce();
    w1.setFailMutate(() => RETRYABLE());
    const res = await e1.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    expect(res.status).toBe("queued");
    store1.close();

    // The app is swiped away; a fresh process opens the same database, mobile order again.
    const w2 = wire(new FixturesAdapter());
    const store2 = new SqlMirrorStore({ owner: "origin|acct-m", open: world.open });
    await store2.load();
    const e2 = new OhmailEngine({ adapter: w2.adapter, store: store2, now: () => DEMO_NOW });
    e2.restoreOutbox();

    // Before any network: the restored overlay is in the boot render.
    expect(w2.calls).toHaveLength(0);
    expect(giuliaUnread(e2)).toBe(false);

    await e2.syncOnce();
    expect(w2.calls[0]).toMatchObject({ op: "mutate", kind: "mark_seen", key: res.key });
    expect(store2.get<EngineMessage>("message", "giulia")?.unread).toBe(false);
    expect(outboxRows(store2)).toHaveLength(0);
    store2.close();
  });
});

describe("the overlay outlives a failed reconcile drain (seam 2)", () => {
  it("a confirmed write whose drain died stays on screen, and retires only when a later drain proves the echo applied", async () => {
    const w = wire(new FixturesAdapter());
    const engine = new OhmailEngine({ adapter: w.adapter, now: () => DEMO_NOW });
    await engine.start();
    expect(giuliaUnread(engine)).toBe(true);

    // The POST lands; the post-confirm reconcile drain dies in transit.
    w.failNextSync(new Error("the network died right after the POST"));
    const res = await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    await tick();

    expect(res.status).toBe("confirmed"); // the write landed — the status was always true
    // THE FIX: the row must NOT revert. Before this slice the overlay dropped here and giulia
    // flipped back to unread until the next poll — the reported "mark read multiple times".
    expect(giuliaUnread(engine)).toBe(false);

    // The scheduler's next ordinary drain succeeds: the echo is applied to the MIRROR…
    await engine.syncOnce();
    expect(engine.store.get<EngineMessage>("message", "giulia")?.unread).toBe(false);

    // …and the overlay is genuinely RETIRED, not masking: a later authoritative flip in the
    // mirror shows through immediately. (A standing overlay would pin the read state forever.)
    await flipGiuliaUnreadInMirror(engine);
    expect(giuliaUnread(engine)).toBe(true);
  });

  it("a drain that began BEFORE the POST returned cannot retire the overlay — only a later one", async () => {
    const inner = new FixturesAdapter();
    const calls: Recorded[] = [];
    let holdSync: Promise<void> | null = null;
    let releaseSync!: () => void;
    const adapter: EngineAdapter = {
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: () => inner.fetchBody(),
      async sync(params) {
        calls.push({ op: "sync" });
        // The READ happens at request time; only the response stalls in transit — then dies.
        const resp = await inner.sync(params);
        if (holdSync) {
          const gate = holdSync;
          holdSync = null;
          await gate;
          throw new Error("the stalled poll died in transit");
        }
        return resp;
      },
      async mutate(m, o) {
        calls.push({ op: "mutate", kind: m.kind, key: o.idempotencyKey });
        const out = await inner.mutate(m, o);
        return { changes: [], seq: out.seq };
      },
    };
    const engine = new OhmailEngine({ adapter, now: () => DEMO_NOW });
    await engine.start();

    // A poll is in flight (its log read predates the verb), and it will FAIL.
    holdSync = new Promise<void>((r) => { releaseSync = r; });
    const poll = engine.syncOnce().catch(() => { /* the poller swallows its own */ });
    await tick();

    const mutation = engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    await tick();
    releaseSync();
    const res = await mutation;
    await poll;

    expect(res.status).toBe("confirmed");
    // Whatever drains failed or succeeded in between, the intent never flickered:
    expect(giuliaUnread(engine)).toBe(false);
    // and once a drain that began after the POST completes, the mirror carries it.
    await engine.syncOnce();
    expect(engine.store.get<EngineMessage>("message", "giulia")?.unread).toBe(false);
  });
});

describe("supersession — the newer verb retires the queued older verb it replaces", () => {
  it("a queued read-flag never overwrites the user's newer opposite flag (the flip-back killer)", async () => {
    // The reported class: mark-read queues offline; the network returns; the user marks the
    // same message unread and that COMMITS; the next drive used to replay the stale queued
    // read and put the SERVER back at read. Expressing the newer verb retires the older entry.
    const factory = new IDBFactory();
    const w = wire(new FixturesAdapter());
    const store = new IndexedDbMirrorStore({ owner: "acct-supersede", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: () => DEMO_NOW });
    await engine.start();
    expect(giuliaUnread(engine)).toBe(true);

    w.setFailMutate(() => RETRYABLE());
    const stale = await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    expect(stale.status).toBe("queued");

    w.setFailMutate(null);
    const newer = await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: true });
    expect(newer.status).toBe("confirmed");
    // The stale entry is gone from the queue AND the store — nothing left to replay.
    expect(engine.pendingMutations()).toHaveLength(0);
    expect(outboxRows(store)).toHaveLength(0);

    await engine.syncOnce();
    expect(w.calls.filter((c) => c.op === "mutate" && c.key === stale.key)).toHaveLength(1); // the failed attempt only
    expect(store.get<EngineMessage>("message", "giulia")?.unread).toBe(true);
    expect(giuliaUnread(engine)).toBe(true);
    store.close();
  });

  it("partial overlap narrows the queued entry: untouched ids still deliver under the original key", async () => {
    const factory = new IDBFactory();
    const w = wire(new FixturesAdapter());
    const store = new IndexedDbMirrorStore({ owner: "acct-narrow", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: () => DEMO_NOW });
    await engine.start();

    w.setFailMutate(() => RETRYABLE());
    const stale = await engine.mutate({ kind: "mark_seen", messageIds: ["giulia", "petra"], unread: false });
    w.setFailMutate(null);
    await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: true });

    await engine.syncOnce(); // the drive replays the NARROWED entry
    const replay = w.calls.find((c) => c.op === "mutate" && c.key === stale.key && w.calls.indexOf(c) > 1);
    expect(replay).toBeDefined();
    expect(store.get<EngineMessage>("message", "giulia")?.unread).toBe(true);  // the newer verb held
    expect(store.get<EngineMessage>("message", "petra")?.unread).toBe(false);  // the untouched id delivered
    expect(outboxRows(store)).toHaveLength(0);
    store.close();
  });

  it("a glance never cancels a queued deliberate unread", async () => {
    const factory = new IDBFactory();
    const w = wire(new FixturesAdapter());
    const store = new IndexedDbMirrorStore({ owner: "acct-glance", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: () => DEMO_NOW });
    await engine.start();
    // giulia read first, so the deliberate unread below is a real flip.
    await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });

    w.setFailMutate(() => RETRYABLE());
    const deliberate = await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: true });
    expect(deliberate.status).toBe("queued");
    w.setFailMutate(null);
    // The involuntary glance sweeps over the same id — it must not eat the queued unread.
    await engine.mutate({ kind: "feed_mark_seen", messageIds: ["giulia"] });
    expect(engine.pendingMutations()).toHaveLength(1);

    await engine.syncOnce(); // the deliberate unread replays and lands LAST
    expect(store.get<EngineMessage>("message", "giulia")?.unread).toBe(true);
    store.close();
  });

  it("same scalar target, same kind: only the newest triage survives to replay", async () => {
    const factory = new IDBFactory();
    const w = wire(new FixturesAdapter());
    const store = new IndexedDbMirrorStore({ owner: "acct-scalar", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: () => DEMO_NOW });
    await engine.start();

    w.setFailMutate(() => RETRYABLE());
    const first = await engine.mutate({ kind: "triage_set", messageId: "petra", state: "reply_later" });
    const second = await engine.mutate({ kind: "triage_set", messageId: "petra", state: "set_aside" });
    expect(first.status).toBe("queued");
    expect(second.status).toBe("queued");
    // One entry stands — the newest — in memory and on disk.
    expect(engine.pendingMutations()).toHaveLength(1);
    expect(engine.pendingMutations()[0]!.key).toBe(second.key);
    expect(outboxRows(store)).toHaveLength(1);

    w.setFailMutate(null);
    await engine.syncOnce();
    expect(w.calls.filter((c) => c.op === "mutate" && c.key === first.key)).toHaveLength(1); // never replayed
    expect(outboxRows(store)).toHaveLength(0);
    store.close();
  });
});

describe("the order barrier and host-owned replay", () => {
  it("while a timed-out dispatch is in the air, neither a second drive nor flushPending dispatches behind it", async () => {
    const factory = new IDBFactory();
    const w1 = wire(new FixturesAdapter());
    const store1 = new IndexedDbMirrorStore({ owner: "acct-barrier", factory });
    const e1 = new OhmailEngine({ adapter: w1.adapter, store: store1, now: () => DEMO_NOW });
    await e1.start();
    w1.setFailMutate(() => RETRYABLE());
    // Different targets, as in the batch-stop test: supersession would retire a same-target
    // pair before the barrier ever mattered.
    await e1.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    await e1.mutate({ kind: "triage_set", messageId: "petra", state: "reply_later" });
    store1.close();

    const w2 = wire(new FixturesAdapter());
    w2.hangMutates();
    const store2 = new IndexedDbMirrorStore({ owner: "acct-barrier", factory });
    const e2 = new OhmailEngine({
      adapter: w2.adapter, store: store2, now: () => DEMO_NOW, outboxReplayDeadlineMs: 40,
    });
    await e2.hydrate();
    await e2.syncOnce(); // dispatches the first (it hangs), defers the second, arms the barrier

    expect(w2.calls.filter((c) => c.op === "mutate")).toHaveLength(1);
    await e2.syncOnce(); // a second drive: the barrier holds, no dispatch behind the hung one
    expect(w2.calls.filter((c) => c.op === "mutate")).toHaveLength(1);
    // The owning caller's path honors the barrier WITHOUT starving its caller: every entry answers
    // `queued` (useMailSend re-arms its retry timer off exactly that), and nothing dispatches.
    const held = await e2.flushPending();
    expect(held.length).toBeGreaterThanOrEqual(1);
    expect(held.every((r) => r.status === "queued")).toBe(true);
    expect(w2.calls.filter((c) => c.op === "mutate")).toHaveLength(1);
    // A FRESH verb expressed under the hold paints and queues, but does not go on the wire —
    // supersession cannot see the hung in-flight entry, so dispatching now could be overtaken.
    const fresh = await e2.mutate({ kind: "triage_set", messageId: "giulia", state: "set_aside" });
    expect(fresh.status).toBe("queued");
    expect(w2.calls.filter((c) => c.op === "mutate")).toHaveLength(1);
    expect(e2.pendingMutations()).toHaveLength(2); // the deferred second + the fresh verb, in order
    store2.close();
  });

  it("outboxAutoReplay:false — the drive replays nothing; flushPending routes every result (the mobile shape)", async () => {
    const world = sqlWorld();
    const w1 = wire(new FixturesAdapter());
    const store1 = new SqlMirrorStore({ owner: "origin|acct-hostowned", open: world.open });
    await store1.load();
    const e1 = new OhmailEngine({ adapter: w1.adapter, store: store1, now: () => DEMO_NOW, outboxAutoReplay: false });
    e1.restoreOutbox();
    await e1.syncOnce();
    w1.setFailMutate(() => RETRYABLE());
    const res = await e1.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    store1.close();

    const w2 = wire(new FixturesAdapter());
    const store2 = new SqlMirrorStore({ owner: "origin|acct-hostowned", open: world.open });
    await store2.load();
    const e2 = new OhmailEngine({ adapter: w2.adapter, store: store2, now: () => DEMO_NOW, outboxAutoReplay: false });
    e2.restoreOutbox();
    expect(giuliaUnread(e2)).toBe(false); // the boot render still carries the restored intent

    await e2.syncOnce(); // the drive must NOT consume the entry — the host's ledger owns it
    expect(w2.calls.filter((c) => c.op === "mutate")).toHaveLength(0);
    expect(e2.pendingMutations()).toHaveLength(1);

    const flushed = await e2.flushPending(); // the host's own cadence delivers, results routed
    expect(flushed[0]).toMatchObject({ key: res.key, status: "confirmed" });
    expect(store2.get<EngineMessage>("message", "giulia")?.unread).toBe(false);
    expect(outboxRows(store2)).toHaveLength(0);
    store2.close();
  });
});

describe("supersession — the round-4 boundaries", () => {
  it("two queued tags on one message are independent deltas — neither retires the other", async () => {
    // The wire is `{tagId, assigned}`, not the labels union: replacing the first assignment
    // with the second would un-tag the first on reconciliation.
    const factory = new IDBFactory();
    const w = wire(new FixturesAdapter());
    const store = new IndexedDbMirrorStore({ owner: "acct-tags", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: () => DEMO_NOW });
    await engine.start();

    w.setFailMutate(() => RETRYABLE());
    await engine.mutate({ kind: "tag_assign", messageId: "giulia", tagId: "tag-a", assigned: true, createName: "A" });
    await engine.mutate({ kind: "tag_assign", messageId: "giulia", tagId: "tag-b", assigned: true, createName: "B" });
    expect(engine.pendingMutations()).toHaveLength(2);
    // …while a newer verb about the SAME tag does retire the older one.
    await engine.mutate({ kind: "tag_assign", messageId: "giulia", tagId: "tag-a", assigned: false });
    expect(engine.pendingMutations()).toHaveLength(2);
    store.close();
  });

  it("a REVERSAL of a queued move still reaches the wire — effects are read before supersession", async () => {
    // The queued move may have COMMITTED with its response lost; only the reversal on the wire
    // can undo it. Computing effects after dropping the old overlay read the mirror as already
    // reversed and rejected the verb outright.
    const factory = new IDBFactory();
    const w = wire(new FixturesAdapter());
    const store = new IndexedDbMirrorStore({ owner: "acct-reversal", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: () => DEMO_NOW });
    await engine.start();
    const home = engine.read().get<EngineMessage>("message", "giulia")!.folder;

    // The move COMMITS server-side; only the response is lost — the exact case where the
    // reversal is the ONLY thing that can undo it, so rejecting it as a no-op is fatal.
    w.loseNextMutate();
    const out = await engine.mutate({ kind: "move", messageId: "giulia", folder: "ohmail/Receipts" });
    expect(out.status).toBe("queued");
    const back = await engine.mutate({ kind: "move", messageId: "giulia", folder: home });
    expect(back.status, "the reversal must not be rejected as a no-op").toBe("confirmed");
    // The stale outbound move is retired; the reversal landed; the world is back home.
    expect(engine.pendingMutations().every((p) => p.key !== out.key)).toBe(true);
    await engine.syncOnce();
    expect(store.get<EngineMessage>("message", "giulia")?.folder).toBe(home);
    store.close();
  });

  it("a glance-LABELLED mark_seen (the dwell commit) cannot cancel a queued deliberate unread", async () => {
    const factory = new IDBFactory();
    const w = wire(new FixturesAdapter());
    const store = new IndexedDbMirrorStore({ owner: "acct-via", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: () => DEMO_NOW });
    await engine.start();
    await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });

    w.setFailMutate(() => RETRYABLE());
    const deliberate = await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: true });
    expect(deliberate.status).toBe("queued");
    w.setFailMutate(null);
    // The Ohbox dwell commit: kind mark_seen, but `via: "glance"` — involuntary by its own
    // label. Its confirm triggers a drive, which REPLAYS (not cancels) the deliberate unread:
    // the queued verb reaches the wire again under its own key and lands LAST.
    await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false, via: "glance" });
    await engine.syncOnce();
    expect(
      w.calls.filter((c) => c.op === "mutate" && c.key === deliberate.key).length,
      "the deliberate unread must have been replayed, never cancelled",
    ).toBeGreaterThanOrEqual(2);
    expect(store.get<EngineMessage>("message", "giulia")?.unread).toBe(true);
    store.close();
  });

  it("a newer same-view leave-commit with NO ids still supersedes the older queued waterline", async () => {
    const factory = new IDBFactory();
    const w = wire(new FixturesAdapter());
    const store = new IndexedDbMirrorStore({ owner: "acct-line", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: () => DEMO_NOW });
    await engine.start();

    // Only the id-carrying glance keeps failing, so the narrowed entry stays queued and
    // inspectable; the newer empty-set waterline commit sails through.
    w.setFailMutate((m) => (m.kind === "feed_mark_seen" && (m.messageIds?.length ?? 0) > 0 ? RETRYABLE() : null));
    const old = await engine.mutate({ kind: "feed_mark_seen", view: "reads", messageIds: ["f1"], upToId: "f1" });
    expect(old.status).toBe("queued");
    // The ordinary waterline commit: an anchor and an empty flip set.
    await engine.mutate({ kind: "feed_mark_seen", view: "reads", messageIds: [], upToId: "f2" });

    // The older entry survives for its own flip ids, but its line is gone — replaying it can
    // no longer move the waterline backwards.
    const held = engine.pendingMutations().find((p) => p.key === old.key);
    expect(held).toBeDefined();
    expect((held!.mutation as { upToId?: string }).upToId).toBeUndefined();
    store.close();
  });
});

describe("the round-5 boundaries", () => {
  it("a repeat of a queued verb (an optimistic no-op) never retires the original intent", async () => {
    // Re-pressing move-to-Receipts while the first press is still queued: the optimistic
    // destination makes the repeat a no-op (rolled_back, nothing on the wire) — and the
    // QUEUED original must survive it, because it may be the only copy of an intent whose
    // first attempt never reached the server.
    const factory = new IDBFactory();
    const w = wire(new FixturesAdapter());
    const store = new IndexedDbMirrorStore({ owner: "acct-repeat", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: () => DEMO_NOW });
    await engine.start();

    w.setFailMutate(() => RETRYABLE());
    const original = await engine.mutate({ kind: "move", messageId: "giulia", folder: "ohmail/Receipts" });
    expect(original.status).toBe("queued");
    const repeat = await engine.mutate({ kind: "move", messageId: "giulia", folder: "ohmail/Receipts" });
    expect(repeat.status).toBe("rolled_back"); // the no-op is refused, as ever…
    expect(engine.pendingMutations().some((p) => p.key === original.key), "…but the original stands").toBe(true);
    expect(outboxRows(store)).toHaveLength(1);
    store.close();
  });

  it("the guard covers a replay attempt from its FIRST millisecond — a fresh verb cannot race a slow restored one", async () => {
    const factory = new IDBFactory();
    const w1 = wire(new FixturesAdapter());
    const store1 = new IndexedDbMirrorStore({ owner: "acct-active", factory });
    const e1 = new OhmailEngine({ adapter: w1.adapter, store: store1, now: () => DEMO_NOW });
    await e1.start();
    w1.setFailMutate(() => RETRYABLE());
    await e1.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    store1.close();

    const w2 = wire(new FixturesAdapter());
    const store2 = new IndexedDbMirrorStore({ owner: "acct-active", factory });
    const e2 = new OhmailEngine({ adapter: w2.adapter, store: store2, now: () => DEMO_NOW });
    await e2.hydrate();
    // The restored replay's request is SLOW but not timed out — held open by the gate.
    const release = w2.gateNextMutate();
    const drive = e2.syncOnce();
    await tick();
    expect(w2.calls.filter((c) => c.op === "mutate")).toHaveLength(1); // the replay, in the air

    // A fresh verb lands mid-attempt: it must WAIT, not dispatch beside the slow replay.
    const fresh = e2.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: true });
    await tick();
    expect(w2.calls.filter((c) => c.op === "mutate")).toHaveLength(1);

    release();
    const res = await fresh;
    await drive;
    // Both dispatched, in order: the restored read first, the fresh unread after — so the
    // fresh (newer) verb is what the server holds.
    expect(res.status).toBe("confirmed");
    const keys = w2.calls.filter((c) => c.op === "mutate");
    expect(keys).toHaveLength(2);
    expect(store2.get<EngineMessage>("message", "giulia")?.unread).toBe(true);
    store2.close();
  });

  it("a first draft autosave under the long hold WAITS for it and still hands back the created id", async () => {
    const factory = new IDBFactory();
    const w1 = wire(new FixturesAdapter());
    const store1 = new IndexedDbMirrorStore({ owner: "acct-create-hold", factory });
    const e1 = new OhmailEngine({ adapter: w1.adapter, store: store1, now: () => DEMO_NOW });
    await e1.start();
    w1.setFailMutate(() => RETRYABLE());
    await e1.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    store1.close();

    const w2 = wire(new FixturesAdapter());
    const store2 = new IndexedDbMirrorStore({ owner: "acct-create-hold", factory });
    const e2 = new OhmailEngine({
      adapter: w2.adapter, store: store2, now: () => DEMO_NOW, outboxReplayDeadlineMs: 30,
    });
    await e2.hydrate();
    const release = w2.gateNextMutate();
    await e2.syncOnce(); // the gated replay exceeds its 30ms deadline → the long hold arms

    // The composer's first autosave: it must not be orphaned as `queued` (nothing would ever
    // retry it and every further edit would mint a twin) — it waits the hold out.
    const create = e2.mutate({
      kind: "draft_save", draftId: null, mailboxId: "mb-milabrunner",
      inReplyToMessageId: null, subject: "held", body: "…", to: [], cc: [], bcc: [],
    });
    await tick();
    expect(w2.calls.filter((c) => c.op === "mutate" && c.kind === "draft_save")).toHaveLength(0);

    release(); // the hung replay settles; the hold clears; the create dispatches
    const res = await create;
    // Confirmed with a real dispatch — the result reached ITS caller (the FixturesAdapter
    // mints no entityId; the HTTP adapter does, and either way the caller got the result
    // rather than an orphaned queued status).
    expect(res.status).toBe("confirmed");
    expect(w2.calls.filter((c) => c.op === "mutate" && c.kind === "draft_save")).toHaveLength(1);
    store2.close();
  });

  it("a deliberate mark-unread subtracts a queued stale read even under a glance label", async () => {
    const factory = new IDBFactory();
    const w = wire(new FixturesAdapter());
    const store = new IndexedDbMirrorStore({ owner: "acct-unread-label", factory });
    const engine = new OhmailEngine({ adapter: w.adapter, store, now: () => DEMO_NOW });
    await engine.start();

    w.setFailMutate(() => RETRYABLE());
    const staleRead = await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    expect(staleRead.status).toBe("queued");
    w.setFailMutate(null);
    // `unread: true` is a deliberate act whatever label rode along — it must retire the
    // queued stale read, or the next drive replays it and flips the server back.
    await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: true, via: "glance" });
    expect(engine.pendingMutations().some((p) => p.key === staleRead.key)).toBe(false);

    await engine.syncOnce();
    expect(w.calls.filter((c) => c.op === "mutate" && c.key === staleRead.key)).toHaveLength(1);
    expect(store.get<EngineMessage>("message", "giulia")?.unread).toBe(true);
    store.close();
  });
});

describe("the round-6 boundary", () => {
  it("a waiter on a hung replay attempt is released AT THE DEADLINE and lands queued — never suspended past it", async () => {
    // The waiter promise must not inherit the attempt's unboundedness: a request that never
    // settles would otherwise suspend every fresh mutate (a compose autosave included) until
    // restart — precisely the stranding the deadline exists to end.
    const factory = new IDBFactory();
    const w1 = wire(new FixturesAdapter());
    const store1 = new IndexedDbMirrorStore({ owner: "acct-waiter", factory });
    const e1 = new OhmailEngine({ adapter: w1.adapter, store: store1, now: () => DEMO_NOW });
    await e1.start();
    w1.setFailMutate(() => RETRYABLE());
    await e1.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    store1.close();

    const w2 = wire(new FixturesAdapter());
    w2.hangMutates();
    const store2 = new IndexedDbMirrorStore({ owner: "acct-waiter", factory });
    const e2 = new OhmailEngine({
      adapter: w2.adapter, store: store2, now: () => DEMO_NOW, outboxReplayDeadlineMs: 60,
    });
    await e2.hydrate();
    const drive = e2.syncOnce();
    await tick(); // the hung replay attempt is in the air; the guard is armed

    // A fresh verb lands mid-attempt. It must resolve — as `queued`, behind the hold the
    // deadline is about to arm — rather than hang on the attempt for ever.
    const res = await e2.mutate({ kind: "triage_set", messageId: "petra", state: "reply_later" });
    expect(res.status).toBe("queued");
    await drive;
    expect(e2.pendingMutations().some((p) => p.mutation.kind === "triage_set")).toBe(true);
    store2.close();
  });
});
