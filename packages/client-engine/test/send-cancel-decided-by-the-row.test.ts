/**
 * A CANCEL IN ANOTHER WINDOW IS DECIDED BY THE OUTBOX ROW (hand back 1).
 * The owning window claims its row `sending` in the transaction that reads a Cancel's mark; the mark refuses
 * a claimed or confirmed row. Each side answers from its own transaction and nothing waits on a
 * clock. The controls are the reviewer's routes; two engines over ONE IndexedDB disk with
 * ONE injected Web Locks registry, the row's owner read off the disk first.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { IDBFactory, IDBKeyRange as FakeKeyRange } from "fake-indexeddb";
import {
  IndexedDbMirrorStore, MutationRejectedError, OhmailEngine, OUTBOX_TYPE, OUTBOX_WITHDRAWN_CODE,
  type EngineLocks, type EngineMutation, type MutationResult,
} from "@ohmail/client-engine";

const tick = (ms = 5): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms); });
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await tick();
  if (!cond()) throw new Error(`never reached: ${what}`);
}
const msg = (id: string) => ({
  id, accountId: "acct", mailboxId: "mb-1", threadId: null, messageIdHeader: `<${id}@x>`, subject: "Invoice",
  from: { name: "Ada", address: "ada@fake.test" }, to: [], cc: [], date: new Date().toISOString(), folder: "INBOX",
  snippet: "", unread: true, hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: new Date().toISOString(),
});
function registry() {
  const held = new Map<string, () => void>();
  const api: EngineLocks = {
    async request(name, _o, cb) {
      held.set(name, () => undefined);
      const p = cb({ name });
      void Promise.resolve(p).then(() => { held.delete(name); });
      return p;
    },
    async query() { return { held: [...held.keys()].map((name) => ({ name })) }; },
  };
  return { api, held, close: (name: string) => { held.delete(name); } };
}
function server() {
  const reserved = new Set<string>();
  const deliveries: string[] = [];
  const net = { offline: false, echo: false };
  // The browser's own word on the network, as a claim reads it: offline sends nothing, no wire fact.
  Object.defineProperty(globalThis.navigator, "onLine", { get: () => !net.offline, configurable: true });
  // The withdraw route over the same ledger: a key it holds is `already_sent`, any other tombstoned.
  const tombstones = new Set<string>();
  let gate: Promise<void> | null = null;
  const adapter = {
    sync: async () => {
      if (net.offline) throw new MutationRejectedError("network failure", { code: "network", retryable: true });
      return {
        changes: { creates: [{ type: "message", id: "m-1", seq: 1, updatedAt: new Date().toISOString(), entity: msg("m-1") }], updates: [], moves: [], deletes: [] },
        cursor: "1", hasMore: false, serverTime: new Date().toISOString(),
      };
    },
    fetchBody: async () => null,
    withdrawSend: async (key: string) => {
      if (net.offline) return { outcome: "unreachable" as const };
      if (reserved.has(key)) return { outcome: "already_sent" as const, firstSend: { status: "sent", at: new Date().toISOString() } };
      tombstones.add(key);
      return { outcome: "withdrawn" as const };
    },
    mutate: async (m: EngineMutation, o: { idempotencyKey: string }) => {
      if (net.offline) throw new MutationRejectedError("network failure", { code: "network", retryable: true });
      if (gate !== null) { const g = gate; gate = null; await g; }
      if (m.kind === "mail_send" && tombstones.has(o.idempotencyKey)) {
        throw new MutationRejectedError("cancelled before it left", { status: 409, code: "withdrawn", retryable: false });
      }
      if (m.kind !== "mail_send") return { changes: [], seq: null };
      if (reserved.has(o.idempotencyKey)) return { changes: [], seq: null, firstSend: { status: "sent", at: new Date().toISOString() } };
      reserved.add(o.idempotencyKey);
      deliveries.push(o.idempotencyKey);
      if (net.echo) {
        return { changes: [{ type: "draft", op: "update", id: `row-${o.idempotencyKey}`, seq: 2, updatedAt: new Date().toISOString(), entity: { id: `row-${o.idempotencyKey}`, status: "sent" } }], seq: 2 };
      }
      return { changes: [], seq: null };
    },
  };
  return {
    adapter, net, deliveries,
    hold(): () => void { let open!: () => void; gate = new Promise<void>((r) => { open = r; }); return () => open(); },
  };
}
const SEND = {
  kind: "mail_send", inReplyTo: "m-1", body: "Thanks, Ada.", subject: "Re: Invoice", mailboxId: "mb-1",
  to: [{ name: "Ada", address: "ada@fake.test" }],
} as unknown as EngineMutation;
type Tab = { store: IndexedDbMirrorStore; engine: OhmailEngine; name: () => string | null };
/** The registry as one window asks it, and the name that window's lock was granted under. */
function grantOf(locks: EngineLocks | null) {
  let granted: string | null = null;
  const api: EngineLocks | null = locks === null ? null : {
    request: (name, o, cb) => locks.request(name, o, (l) => { granted = name; return cb(l); }),
    query: () => locks.query(),
  };
  return { api, name: () => granted };
}
async function open(factory: IDBFactory, locks: EngineLocks | null, srv: ReturnType<typeof server>): Promise<Tab> {
  const lock = grantOf(locks);
  const store = new IndexedDbMirrorStore({ owner: "acct-row", factory });
  const engine = new OhmailEngine({ adapter: srv.adapter as never, store, locks: lock.api } as never);
  await engine.start().catch(() => undefined);
  return { store, engine, name: lock.name };
}
type Row = { key: string; owner?: string; withdrawn?: boolean; confirmed?: boolean; sending?: string; protocol?: number };
const rows = (t: Tab) => t.store.entries<Row>(OUTBOX_TYPE).map((e) => e.entity);
async function diskRows(factory: IDBFactory): Promise<Row[]> {
  const probe = new IndexedDbMirrorStore({ owner: "acct-row", factory, notices: () => null });
  await probe.load();
  const out = probe.entries<Row>(OUTBOX_TYPE).map((e) => e.entity);
  probe.close();
  return out;
}
/** Hold one store's write lane, as a drain page being written holds it. */
function holdLane(s: IndexedDbMirrorStore): () => void {
  let free!: () => void;
  const g = new Promise<void>((r) => { free = r; });
  void (s as unknown as { serializeWrite: (fn: () => Promise<void>) => Promise<void> }).serializeWrite(() => g);
  return () => free();
}
async function queuedIn(factory: IDBFactory, reg: ReturnType<typeof registry>, srv: ReturnType<typeof server>) {
  const A = await open(factory, reg.api, srv);
  const B = await open(factory, reg.api, srv);
  srv.net.offline = true;
  const res = await A.engine.mutate(SEND);
  expect(res.status).toBe("queued");
  expect((await diskRows(factory)).map((r) => r.owner), "the row names A's lock").toEqual([A.name()]);
  await until(() => rows(B).some((r) => r.key === res.key), "B reads A's row");
  return { A, B, res };
}

describe("a Cancel in another window is decided by the row", () => {
  beforeAll(() => { (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange ??= FakeKeyRange; });

  it("the owning window's write lane is busy as it dispatches: the mark wins, B says withdrawn, A's claim refuses, 0 deliveries", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    const { A, B, res } = await queuedIn(factory, reg, srv);
    srv.net.offline = false;
    const free = holdLane(A.store);
    const flight = A.engine.retryQueued(res.id);
    await until(() => A.engine.inFlightMutations().some((p) => p.key === res.key), "A's dispatch is in flight");
    const outcome = await B.engine.withdrawQueued(res.key);
    free();
    const r = await flight;
    expect({ outcome, a: r?.status, code: r?.error?.code, deliveries: srv.deliveries.length })
      .toEqual({ outcome: "withdrawn", a: "rolled_back", code: OUTBOX_WITHDRAWN_CODE, deliveries: 0 });
  });

  it("the other order: A's claim lands first, so B is told on its way and it goes once", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    const { A, B, res } = await queuedIn(factory, reg, srv);
    srv.net.offline = false;
    const release = srv.hold();
    const flight = A.engine.retryQueued(res.id);
    await until(() => (rows(B).find((r) => r.key === res.key)?.sending ?? null) !== null, "B reads A's claim");
    const outcome = await B.engine.withdrawQueued(res.key);
    release(); await flight;
    expect({ outcome, deliveries: srv.deliveries.length }).toEqual({ outcome: "on_the_wire", deliveries: 1 });
  });

  it("the owning window's request is out and that window slow: B is told on its way, 1 delivery, the row unmarked", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    const { A, B, res } = await queuedIn(factory, reg, srv);
    srv.net.offline = false;
    const release = srv.hold();
    const flight = A.engine.retryQueued(res.id);
    await until(() => A.engine.inFlightMutations().some((p) => p.key === res.key), "A's request is out");
    await tick(20);
    const free = holdLane(A.store);
    const outcome = await B.engine.withdrawQueued(res.key);
    const disk = await diskRows(factory);
    free(); release(); await flight;
    expect({ outcome, deliveries: srv.deliveries.length, marked: disk.some((r) => r.withdrawn === true) })
      .toEqual({ outcome: "on_the_wire", deliveries: 1, marked: false });
  });

  it("the owning window closes with its request out: B is told on its way, adopts, and the replay is answered once", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    const { A, B, res } = await queuedIn(factory, reg, srv);
    srv.net.offline = false;
    const release = srv.hold();
    void A.engine.retryQueued(res.id);
    await until(() => A.engine.inFlightMutations().some((p) => p.key === res.key), "A's request is out");
    await tick(20);
    A.store.close(); reg.close(A.name()!);
    const outcome = await B.engine.withdrawQueued(res.key);
    release();
    await B.engine.syncOnce();
    const late: MutationResult[] = [...await B.engine.flushPending()];
    expect({ outcome, deliveries: srv.deliveries.length }).toEqual({ outcome: "on_the_wire", deliveries: 1 });
    expect(late.find((r) => r.key === res.key)?.firstSend, "B's replay is answered from the reservation").toBeDefined();
  });

  it("a confirmed row kept for its echo: B's late Cancel is told it went, the row is not marked, 1 delivery", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    const { A, B, res } = await queuedIn(factory, reg, srv);
    srv.net.offline = false; srv.net.echo = true;
    const apply = A.store.applyChanges.bind(A.store);
    A.store.applyChanges = (async (...a: Parameters<typeof apply>) => {
      if ((a[0] as Array<{ type: string }>).some((c) => c.type === "draft")) throw new Error("QuotaExceededError");
      return apply(...a);
    }) as typeof A.store.applyChanges;
    const freeB = holdLane(B.store);
    await A.engine.flushPending();
    await tick(30);
    const said = B.engine.withdrawQueued(res.key);
    freeB();
    const outcome = await said;
    const disk = await diskRows(factory);
    expect({ outcome, deliveries: srv.deliveries.length, disk: disk.map((r) => ({ confirmed: r.confirmed ?? false, withdrawn: r.withdrawn ?? false })) })
      .toEqual({ outcome: "on_the_wire", deliveries: 1, disk: [{ confirmed: true, withdrawn: false }] });
  });

  it("a Cancel on a row already delivered and dropped answers on its way, not gone (its owner said confirmed)", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    const { A, B, res } = await queuedIn(factory, reg, srv);
    srv.net.offline = false;
    const freeB = holdLane(B.store);
    await A.engine.flushPending();
    await tick(30);
    const said = B.engine.withdrawQueued(res.key);
    freeB();
    expect({ outcome: await said, deliveries: srv.deliveries.length }).toEqual({ outcome: "on_the_wire", deliveries: 1 });
  });

  it("an older build's row (no protocol stamp): no Cancel from here, nothing marked, it goes once", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    const { A, B, res } = await queuedIn(factory, reg, srv);
    // The row as an older build writes it: an owner, no protocol, and an owner that never claims.
    const raw = A.store as unknown as { decideOutboxRow?: unknown };
    raw.decideOutboxRow = undefined;
    await A.store.commitLocal([{ type: OUTBOX_TYPE, id: res.id, entity: { ...(await diskRows(factory))[0], protocol: undefined } }], []);
    await until(() => rows(B).some((r) => r.key === res.key && r.protocol === undefined), "B reads the older row");
    expect(B.engine.foreignCancelRefused(res.key)).toBe(true);
    const outcome = await B.engine.withdrawQueued(res.key);
    srv.net.offline = false;
    await A.engine.flushPending();
    expect({ outcome, marked: (await diskRows(factory)).some((r) => r.withdrawn === true), deliveries: srv.deliveries.length })
      .toEqual({ outcome: "unknown", marked: false, deliveries: 1 });
  });

  it("HAND BACK 2 the viewer's mark transaction fails: unknown, nothing marked; a second Cancel withdraws it, 0 deliveries", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    const { A, B, res } = await queuedIn(factory, reg, srv);
    const s = B.store as unknown as { decideOutboxRow: (...a: unknown[]) => Promise<unknown> };
    const real = s.decideOutboxRow.bind(B.store);
    s.decideOutboxRow = async () => { throw new Error("QuotaExceededError"); };
    const first = await B.engine.withdrawQueued(res.key);
    const markedAfterFirst = (await diskRows(factory)).some((r) => r.withdrawn === true);
    s.decideOutboxRow = real;
    const second = await B.engine.withdrawQueued(res.key);
    srv.net.offline = false;
    for (const t of [A, B]) { await t.engine.syncOnce(); await t.engine.flushPending(); }
    expect({ first, markedAfterFirst, second, deliveries: srv.deliveries.length })
      .toEqual({ first: "unknown", markedAfterFirst: false, second: "withdrawn", deliveries: 0 });
  });

  it("the owning window's twin: a claim the disk cannot answer sends nothing that round, then goes once", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    const { A, res } = await queuedIn(factory, reg, srv);
    const s = A.store as unknown as { decideOutboxRow: (...a: unknown[]) => Promise<unknown> };
    const real = s.decideOutboxRow.bind(A.store);
    s.decideOutboxRow = async () => { throw new Error("UnknownError"); };
    srv.net.offline = false;
    const round = await A.engine.retryQueued(res.id);
    const afterFailedRound = srv.deliveries.length;
    s.decideOutboxRow = real;
    await A.engine.retryQueued(res.id);
    expect({ status: round?.status, code: round?.error?.code, afterFailedRound, deliveries: srv.deliveries.length })
      .toEqual({ status: "queued", code: "network", afterFailedRound: 0, deliveries: 1 });
  });

  it("HAND BACK 2 a row gone with no ending heard answers unknown, not gone", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    const { B, res } = await queuedIn(factory, reg, srv);
    // The row leaves the disk behind B's back (no notice, no ending said); B's copy still shows it.
    const other = new IndexedDbMirrorStore({ owner: "acct-row", factory, notices: () => null });
    await other.load();
    await other.commitLocal([], [{ type: OUTBOX_TYPE, id: res.id }]);
    other.close();
    expect(rows(B).some((r) => r.key === res.key), "B's copy still shows the row").toBe(true);
    expect(await B.engine.withdrawQueued(res.key)).toBe("unknown");
  });

  it("the owning window's own Cancel the disk does not take: unknown, the send back on the queue; again: withdrawn", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    const { A, res } = await queuedIn(factory, reg, srv);
    const st = A.store as unknown as { commitLocal: (...a: unknown[]) => Promise<void>; pruneSerialized: (...a: unknown[]) => Promise<void> };
    const commit = st.commitLocal.bind(A.store); const prune = st.pruneSerialized.bind(A.store);
    st.commitLocal = async () => { throw new Error("QuotaExceededError"); };
    st.pruneSerialized = async () => { throw new Error("QuotaExceededError"); };
    const first = await A.engine.withdrawQueued(res.key);
    const queuedAfterFirst = A.engine.pendingMutations().some((p) => p.key === res.key);
    st.commitLocal = commit; st.pruneSerialized = prune;
    const second = await A.engine.withdrawQueued(res.key);
    srv.net.offline = false;
    await A.engine.flushPending();
    expect({ first, queuedAfterFirst, second, deliveries: srv.deliveries.length })
      .toEqual({ first: "unknown", queuedAfterFirst: true, second: "withdrawn", deliveries: 0 });
  });

  it("LOW 3 an engine a live page replaces: undisposed, its rows stall; disposed, the next engine adopts and sends once", async () => {
    for (const disposeFirst of [false, true]) {
      const factory = new IDBFactory(); const reg = registry(); const srv = server();
      const A = await open(factory, reg.api, srv);
      srv.net.offline = true;
      const res = await A.engine.mutate(SEND);
      expect((await diskRows(factory)).map((r) => r.owner)).toEqual([A.name()]);
      if (disposeFirst) A.engine.dispose();
      A.store.close();
      // The same page builds the next engine over the same disk; A's object is dropped, not unloaded.
      const reopenedA = await open(factory, reg.api, srv);
      srv.net.offline = false;
      await reopenedA.engine.syncOnce(); await reopenedA.engine.syncOnce();
      expect({ disposeFirst, deliveries: srv.deliveries.length, aLockHeld: reg.held.has(A.name() ?? "") })
        .toEqual(disposeFirst ? { disposeFirst, deliveries: 1, aLockHeld: false } : { disposeFirst, deliveries: 0, aLockHeld: true });
    }
  });
});

describe("a re-read of the disk does not bring back a row this store is deleting", () => {
  beforeAll(() => { (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange ??= FakeKeyRange; });

  it("a refresh queued before the delete reads the row; the evicted row stays out of memory", async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbMirrorStore({ owner: "acct-row", factory, notices: () => null });
    await store.load();
    await store.commitLocal([{ type: OUTBOX_TYPE, id: "r-1", entity: { v: 3, id: "r-1", key: "K", n: 0, at: 1, mutation: { kind: "mail_send" } } }], []);
    const free = holdLane(store);
    const refresh = store.refreshOutbox(() => new Set());
    const drop = store.pruneSerialized([{ type: OUTBOX_TYPE, id: "r-1" }]);
    free();
    await refresh; await drop;
    expect({ memory: store.entries(OUTBOX_TYPE).length, disk: (await diskRows(factory)).length }).toEqual({ memory: 0, disk: 0 });
    store.close();
  });
});
