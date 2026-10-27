/**
 * A WAITING SEND IS DISPATCHED BY EXACTLY ONE ENGINE (the engine half).
 * Two or three engines over ONE IndexedDB disk, each holding its own Web Lock from ONE injected
 * registry (jsdom and node have none, so an uninjected probe measures the branch no browser takes).
 * Every case reads the row's `owner` off the disk first. The server double answers as production
 * does: one reservation per key for ever, a second arrival answered from it with `firstSend`.
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

/** One browser's lock registry; `close(name)` is a tab going away. */
function registry() {
  const held = new Set<string>();
  const api: EngineLocks = {
    async request(name, _o, cb) { held.add(name); return cb({ name }); },
    async query() { return { held: [...held].map((name) => ({ name })) }; },
  };
  return { api, held, close: (name: string) => { held.delete(name); } };
}

/**
 * The server: one reservation per key; `offline` refuses the wire; `hold()` parks the next send's
 * answer until released; `lose()` takes the next send and never answers (its tab went away).
 */
function server() {
  const reserved = new Set<string>();
  const deliveries: string[] = [];
  const net = { offline: false };
  // The browser's own word on the network, as a claim reads it: offline sends nothing, no wire fact.
  Object.defineProperty(globalThis.navigator, "onLine", { get: () => !net.offline, configurable: true });
  // The withdraw route over the same ledger: a key it holds is `already_sent`, any other tombstoned.
  const tombstones = new Set<string>();
  let gate: Promise<void> | null = null;
  let losing = false;
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
      if (reserved.has(o.idempotencyKey)) {
        return { changes: [], seq: null, firstSend: { status: "sent", at: new Date().toISOString() } };
      }
      reserved.add(o.idempotencyKey);
      deliveries.push(o.idempotencyKey);
      if (losing) { losing = false; return new Promise<never>(() => { /* the answer never comes */ }); }
      return { changes: [], seq: null };
    },
  };
  return {
    adapter, net, deliveries,
    hold(): () => void { let open!: () => void; gate = new Promise<void>((r) => { open = r; }); return () => open(); },
    lose(): void { losing = true; },
  };
}

const SEND = (body: string): EngineMutation => ({
  kind: "mail_send", inReplyTo: "m-1", body, subject: "Re: Invoice", mailboxId: "mb-1",
  to: [{ name: "Ada", address: "ada@fake.test" }],
} as unknown as EngineMutation);

type Tab = { store: IndexedDbMirrorStore; engine: OhmailEngine; name: () => string | null };

async function open(factory: IDBFactory, locks: EngineLocks | null, srv: ReturnType<typeof server>): Promise<Tab> {
  const store = new IndexedDbMirrorStore({ owner: "acct-windows", factory });
  const engine = new OhmailEngine({
    adapter: srv.adapter as never, store, locks,
  } as never);
  await engine.start().catch(() => undefined);
  const name = (): string | null => (engine as unknown as { ownerName: string | null }).ownerName;
  return { store, engine, name };
}

type Row = { key: string; owner?: string; withdrawn?: boolean; confirmed?: boolean };
const rows = (t: Tab) => t.store.entries<Row>(OUTBOX_TYPE).map((e) => e.entity);
const queuedKeys = (t: Tab) => t.engine.pendingMutations().map((p) => p.key);
async function diskRows(factory: IDBFactory) {
  const probe = new IndexedDbMirrorStore({ owner: "acct-windows", factory, notices: () => null });
  await probe.load();
  const out = probe.entries<{ key: string; owner?: string; withdrawn?: boolean }>(OUTBOX_TYPE).map((e) => e.entity);
  probe.close();
  return out;
}

describe("a waiting send has exactly one engine that sends it", () => {
  beforeAll(() => { (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange ??= FakeKeyRange; });

  for (const order of ["B opens before A presses", "B opens after A presses"] as const) {
    it(`two windows, ${order}: queued in A only, seen by B within one notice, one delivery`, async () => {
      const factory = new IDBFactory(); const reg = registry(); const srv = server();
      const A = await open(factory, reg.api, srv);
      let B: Tab | null = order === "B opens before A presses" ? await open(factory, reg.api, srv) : null;
      srv.net.offline = true;
      const res = await A.engine.mutate(SEND("Thanks, Ada."));
      expect(res.status, String(res.error?.code) + " " + String(res.error?.message)).toBe("queued");
      const disk = await diskRows(factory);
      expect(disk.map((r) => r.owner), "the row names A's lock").toEqual([A.name()]);
      B ??= await open(factory, reg.api, srv);
      await until(() => rows(B!).some((r) => r.key === res.key), "B reads A's row from the disk");
      expect(queuedKeys(A)).toContain(res.key);
      expect(queuedKeys(B), "B never queues A's row").not.toContain(res.key);
      srv.net.offline = false;
      await B.engine.syncOnce(); await A.engine.flushPending(); await B.engine.syncOnce();
      await until(() => !rows(B!).some((r) => r.key === res.key && r.confirmed !== true), "the ending reaches B's memory");
      expect(srv.deliveries).toEqual([res.key]);
      A.store.close(); B.store.close();
    });
  }

  it("three windows: the row is queued in its owner only, one delivery", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    const B = await open(factory, reg.api, srv);
    const A = await open(factory, reg.api, srv);
    srv.net.offline = true;
    const res = await A.engine.mutate(SEND("Thanks, Ada."));
    const C = await open(factory, reg.api, srv);
    expect((await diskRows(factory)).map((r) => r.owner)).toEqual([A.name()]);
    await until(() => rows(B).some((r) => r.key === res.key) && rows(C).some((r) => r.key === res.key), "B and C read it");
    expect([queuedKeys(B), queuedKeys(C)].flat()).not.toContain(res.key);
    srv.net.offline = false;
    for (const t of [B, C]) await t.engine.syncOnce();
    await A.engine.flushPending();
    for (const t of [B, C]) await t.engine.syncOnce();
    expect(srv.deliveries).toEqual([res.key]);
    for (const t of [A, B, C]) t.store.close();
  });

  it("the owning window reloads mid-send: exactly one of the reloaded owner and B adopts, one delivery", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    const B = await open(factory, reg.api, srv);
    const A = await open(factory, reg.api, srv);
    srv.net.offline = true;
    const res = await A.engine.mutate(SEND("Thanks, Ada."));
    const aName = A.name()!;
    A.store.close(); reg.close(aName);
    const reopenedA = await open(factory, reg.api, srv);
    srv.net.offline = true;
    await Promise.all([reopenedA.engine.syncOnce().catch(() => undefined), B.engine.syncOnce().catch(() => undefined)]);
    const owners = (await diskRows(factory)).map((r) => r.owner);
    expect(owners).toHaveLength(1);
    expect([reopenedA.name(), B.name()], "one live engine adopted it").toContain(owners[0]);
    const holders = [reopenedA, B].filter((t) => queuedKeys(t).includes(res.key));
    expect(holders, "exactly one engine queued it").toHaveLength(1);
    const other = holders[0] === reopenedA ? B : reopenedA;
    await until(() => rows(other).some((r) => r.key === res.key && r.owner === owners[0]), "the other sees the owning window move");
    srv.net.offline = false;
    for (const t of [reopenedA, B]) { await t.engine.syncOnce(); await t.engine.flushPending(); }
    expect(srv.deliveries).toEqual([res.key]);
    reopenedA.store.close(); B.store.close();
  });

  for (const [arm, bOpens] of [["withdrawn", "before"], ["on_the_wire", "before"], ["silent", "before"], ["withdrawn", "after"], ["silent", "after"]] as const) {
    it(`Cancel in B (opened ${bOpens} A's press), the owning window ${arm === "silent" ? "silent" : `answers ${arm}`}`, async () => {
      const factory = new IDBFactory(); const reg = registry(); const srv = server();
      const A = await open(factory, reg.api, srv);
      let B: Tab | null = bOpens === "before" ? await open(factory, reg.api, srv) : null;
      srv.net.offline = true;
      const res = await A.engine.mutate(SEND("Thanks, Ada."));
      expect((await diskRows(factory)).map((r) => r.owner)).toEqual([A.name()]);
      // The cap's route: B opened (or reloaded) after the press reads the row at its own boot.
      B ??= await open(factory, reg.api, srv);
      await until(() => rows(B).some((r) => r.key === res.key), "B reads it");
      let release: (() => void) | null = null;
      let flight: Promise<unknown> | null = null;
      if (arm === "on_the_wire") {
        srv.net.offline = false;
        release = srv.hold();
        flight = A.engine.retryQueued(res.id);
        await until(() => A.engine.inFlightMutations().some((p) => p.key === res.key), "A's request is out");
      }
      if (arm === "silent") (A.engine as unknown as { notices: unknown }).notices = null; // A hears and says nothing
      if (arm === "silent") (A.store as unknown as { bus: { close: () => void } }).bus.close();
      const said = await B.engine.withdrawQueued(res.key);
      expect(said).toBe(arm === "on_the_wire" ? "on_the_wire" : "withdrawn");
      release?.();
      await flight;
      srv.net.offline = false;
      const late: MutationResult[] = [];
      for (let i = 0; i < 3; i++) {
        for (const t of [A, B]) { await t.engine.syncOnce(); late.push(...await t.engine.flushPending()); }
      }
      expect(srv.deliveries).toEqual(arm === "on_the_wire" ? [res.key] : []);
      if (arm === "silent") {
        const refused = late.find((r) => r.key === res.key);
        expect(refused?.status, "A's next dispatch read the disk mark").toBe("rolled_back");
        expect(refused?.error?.code).toBe(OUTBOX_WITHDRAWN_CODE);
      }
      if (arm === "withdrawn") {
        expect(late.find((r) => r.key === res.key)?.error?.code, "A's surface hears the cancellation").toBe(OUTBOX_WITHDRAWN_CODE);
      }
      A.store.close(); B.store.close();
    });
  }

  it.each([["made", "hears", undefined], ["named", "hears", "d-named"], ["made", "misses", undefined]] as const)(
    "Cancel in B of a send whose row its press %s, A %s the notice: its withdrawn ending names that row", async (_how, heard, named) => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    const A = await open(factory, reg.api, srv);
    const B = await open(factory, reg.api, srv);
    // A press with no row makes one first (POST /drafts); every send is then refused retryably, so it waits.
    const send = srv.adapter.mutate;
    srv.adapter.mutate = async (m, o) => {
      if (m.kind !== "mail_send") return send(m, o);
      const opts = o as { createdRow?: unknown; onDraftRow?: (row: { id: string; revision: null }) => Promise<void> };
      if (!(m as { draftId?: string }).draftId && opts.createdRow === undefined) await opts.onDraftRow?.({ id: "d-made", revision: null });
      throw new MutationRejectedError("the connection dropped", { code: "network", retryable: true });
    };
    const res = await A.engine.mutate({ ...SEND("Thanks, Ada."), ...(named ? { draftId: named } : {}) } as EngineMutation);
    expect(res.status).toBe("queued");
    await until(() => rows(B).some((r) => r.key === res.key), "B reads it");
    // Missed: A's next dispatch meets B's answered mark on the disk row instead.
    if (heard === "misses") (A.store as unknown as { bus: { close: () => void } }).bus.close();
    expect(await B.engine.withdrawQueued(res.key)).toBe("withdrawn");
    if (heard === "hears") await until(() => A.engine.hasLateResults(), "A hears the Cancel");
    const ended = (await A.engine.flushPending()).find((r) => r.key === res.key);
    expect({ code: ended?.error?.code, row: ended?.entityId, sent: srv.deliveries }).toEqual({ code: OUTBOX_WITHDRAWN_CODE, row: named ?? "d-made", sent: [] });
    A.store.close(); B.store.close();
  });

  it("the owning window closes with the row queued: B adopts and delivers it once", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    const B = await open(factory, reg.api, srv);
    const A = await open(factory, reg.api, srv);
    srv.net.offline = true;
    const res = await A.engine.mutate(SEND("Thanks, Ada."));
    expect((await diskRows(factory)).map((r) => r.owner)).toEqual([A.name()]);
    A.store.close(); reg.close(A.name()!);
    srv.net.offline = false;
    await B.engine.syncOnce(); await B.engine.syncOnce();
    expect(srv.deliveries).toEqual([res.key]);
    B.store.close();
  });

  it("the owning window closes with its request in flight: B's replay is answered from the reservation, one delivery", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    const B = await open(factory, reg.api, srv);
    const A = await open(factory, reg.api, srv);
    srv.net.offline = true;
    const res = await A.engine.mutate(SEND("Thanks, Ada."));
    srv.net.offline = false;
    srv.lose();
    void A.engine.retryQueued(res.id);
    await until(() => srv.deliveries.length === 1, "A's request reached the server");
    A.store.close(); reg.close(A.name()!);
    await B.engine.syncOnce();
    const late = [...await B.engine.flushPending()];
    expect(srv.deliveries).toEqual([res.key]);
    expect(late.find((r) => r.key === res.key)?.firstSend, "B's ending is the reservation's answer").toBeDefined();
    B.store.close();
  });

  it("LOW, the ownerless window: a press before the lock is granted writes a row every window restores; one delivery by its key", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    // A's lock is granted late, as a browser grants it a task or more after the request.
    let grant!: () => void;
    const late: EngineLocks = {
      request: (name, o, cb) => new Promise((resolve) => { grant = () => { resolve(reg.api.request(name, o, cb)); }; }),
      query: () => reg.api.query(),
    };
    const store = new IndexedDbMirrorStore({ owner: "acct-windows", factory });
    const A: Tab = { store, engine: new OhmailEngine({ adapter: srv.adapter as never, store, locks: late } as never), name: () => null };
    await A.engine.start().catch(() => undefined);
    srv.net.offline = true;
    const res = await A.engine.mutate(SEND("Thanks, Ada."));
    grant();
    expect((await diskRows(factory)).map((r) => r.owner ?? null), "pressed before the grant: no owner").toEqual([null]);
    const B = await open(factory, reg.api, srv);
    expect({ a: queuedKeys(A).includes(res.key), b: queuedKeys(B).includes(res.key) }, "both windows hold it as their own").toEqual({ a: true, b: true });
    srv.net.offline = false;
    await A.engine.flushPending(); await B.engine.flushPending();
    expect(srv.deliveries, "the server's key keeps it to one delivery").toEqual([res.key]);
    A.store.close(); B.store.close();
  });

  it("a store that refuses its load: the outbox is unreadable, said once; a load that lands clears it", async () => {
    const store = new IndexedDbMirrorStore({ owner: "acct-windows", factory: new IDBFactory() });
    let refuse = true;
    const load = store.load.bind(store);
    store.load = async () => { if (refuse) throw new Error("the database is blocked"); return load(); };
    const engine = new OhmailEngine({ adapter: server().adapter as never, store, locks: null } as never);
    let notified = 0;
    engine.subscribe(() => { notified++; });
    expect(engine.outboxUnreadable(), "before any load nothing is known to be wrong").toBe(false);
    await engine.hydrate().catch(() => undefined);
    await engine.hydrate().catch(() => undefined);
    expect({ unreadable: engine.outboxUnreadable(), notified }).toEqual({ unreadable: true, notified: 1 });
    refuse = false;
    await engine.hydrate();
    expect(engine.outboxUnreadable()).toBe(false);
    store.close();
  });

  it("locks: null (the shape before ownership): every engine restores every row, as before", async () => {
    const factory = new IDBFactory(); const srv = server();
    const A = await open(factory, null, srv);
    srv.net.offline = true;
    const res = await A.engine.mutate(SEND("Thanks, Ada."));
    const B = await open(factory, null, srv);
    expect((await diskRows(factory)).map((r) => r.owner ?? null)).toEqual([null]);
    expect(queuedKeys(B), "a window with no locks restores the row").toContain(res.key);
    A.store.close(); B.store.close();
  });
});
