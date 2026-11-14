import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange as FakeKeyRange } from "fake-indexeddb";
import {
  HttpAdapter, IndexedDbMirrorStore, MemoryMirrorStore, MutationRejectedError, OhmailEngine, OUTBOX_BACKOFF_CAP_MS, OUTBOX_MAX_SERVER_FAILURES,
  OUTBOX_TYPE, type EngineLocks, type EngineMutation, type MirrorStore, type MutationResult,
} from "@ohmail/client-engine";
import { WITHDRAW_SEND_TIMEOUT_MS } from "../src/adapters/http-adapter.js";

/**
 * CANCEL ACROSS A BUILD SEAM, AND THE OWED CANCEL'S LIMITS.
 * A row of protocol 1 is an older build's: this build never marks it, so its owner replays its own
 * key and the server answers. The other arms are the review's three probes as regression cases, the
 * wire fact on disk before every request, and an owed Cancel's backoff, ceiling, deadline and log.
 */

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

/** A shared lock manager whose grants can be held back (a press before the grant). */
function registry() {
  const held = new Map<string, () => void>();
  let hold = false;
  const gates: Array<() => void> = [];
  const api: EngineLocks = {
    async request(name, _o, cb) {
      if (hold) await new Promise<void>((r) => { gates.push(r); });
      held.set(name, () => undefined);
      const p = cb({ name });
      void Promise.resolve(p).then(() => { held.delete(name); });
      return p;
    },
    async query() { return { held: [...held.keys()].map((name) => ({ name })) }; },
  };
  /** A lock another tab holds for good: its rows are never adopted here. */
  const holdForever = (name: string): void => { void api.request(name, { mode: "exclusive" }, () => new Promise<void>(() => undefined)); };
  return { api, held, holdForever, setHold: (h: boolean) => { hold = h; }, release: () => { for (const g of gates.splice(0)) g(); } };
}

type Ledger = "sent" | "pending" | "withdrawn" | "failed";
function server() {
  const ledger = new Map<string, Ledger>();
  const deliveries: string[] = [];
  const withdraws: string[] = [];
  const net = { offline: false, loseAnswer: false, holdPending: false, withdrawMode: "ledger" as "ledger" | "unreachable" };
  Object.defineProperty(globalThis.navigator, "onLine", { get: () => !net.offline, configurable: true });
  const hooks: { beforeSend?: (key: string) => Promise<void> } = {};
  const adapter = {
    sync: async () => {
      if (net.offline) throw new MutationRejectedError("network failure", { code: "network", retryable: true });
      return {
        changes: { creates: [{ type: "message", id: "m-1", seq: 1, updatedAt: new Date().toISOString(), entity: msg("m-1") }], updates: [], moves: [], deletes: [] },
        cursor: "1", hasMore: false, serverTime: new Date().toISOString(),
      };
    },
    fetchBody: async () => null,
    mutate: async (m: EngineMutation, o: { idempotencyKey: string }) => {
      if (net.offline) throw new MutationRejectedError("network failure", { code: "network", retryable: true });
      if (m.kind !== "mail_send") return { changes: [], seq: null };
      await hooks.beforeSend?.(o.idempotencyKey);
      const held = ledger.get(o.idempotencyKey);
      if (held === "withdrawn") throw new MutationRejectedError("cancelled", { status: 409, code: "withdrawn", retryable: false });
      if (held === "sent") return { changes: [], seq: null, firstSend: { status: "sent", at: new Date().toISOString() } };
      if (held === "failed") throw new MutationRejectedError("A prior send under this key failed and was not delivered.", { status: 409, code: "send_failed", retryable: false });
      if (held === "pending") throw new MutationRejectedError("in progress", { status: 409, code: "send_in_flight", retryable: true });
      if (!net.holdPending) deliveries.push(o.idempotencyKey);
      ledger.set(o.idempotencyKey, net.holdPending ? "pending" : "sent");
      if (net.loseAnswer || net.holdPending) throw new MutationRejectedError("network failure: socket hang up", { code: "network", retryable: true });
      return { changes: [], seq: null };
    },
    withdrawSend: async (key: string): Promise<{ outcome: string; firstSend?: { status: string; at: string }; answered?: boolean; retryAfterMs?: number }> => {
      if (net.offline || net.withdrawMode === "unreachable") return { outcome: "unreachable" };
      withdraws.push(key);
      const held = ledger.get(key);
      if (held === "sent") return { outcome: "already_sent", firstSend: { status: "sent", at: new Date().toISOString() } };
      if (held === "pending") return { outcome: "in_flight" };
      if (held === "failed") return { outcome: "failed" };
      ledger.set(key, "withdrawn");
      return { outcome: "withdrawn" };
    },
  };
  return { adapter, net, deliveries, withdraws, ledger, hooks };
}

const SEND = {
  kind: "mail_send", inReplyTo: "m-1", body: "Thanks, Ada.", subject: "Re: Invoice", mailboxId: "mb-1",
  to: [{ name: "Ada", address: "ada@fake.test" }],
} as unknown as EngineMutation;
type Tab = { store: MirrorStore; engine: OhmailEngine };
const OWNER = "acct-cancel";
async function openIdb(factory: IDBFactory, locks: EngineLocks | null, srv: ReturnType<typeof server>): Promise<Tab> {
  const store = new IndexedDbMirrorStore({ owner: OWNER, factory });
  const engine = new OhmailEngine({ adapter: srv.adapter as never, store, locks } as never);
  await engine.start().catch(() => undefined);
  return { store, engine };
}
type Row = { key: string; owner?: string; withdrawn?: boolean; sending?: string; wired?: boolean; withdrawOwed?: boolean; protocol?: number };
const rows = (t: Tab) => t.store.entries<Row>(OUTBOX_TYPE).map((e) => e.entity);
async function diskRows(factory: IDBFactory): Promise<Row[]> {
  const probe = new IndexedDbMirrorStore({ owner: OWNER, factory, notices: () => null });
  await probe.load();
  const out = probe.entries<Row>(OUTBOX_TYPE).map((e) => e.entity);
  probe.close();
  return out;
}
/** A row as a protocol-1 build writes it: owned, no wire fact, a mark read as final there. */
async function olderBuildRow(factory: IDBFactory, owner: string, key: string): Promise<void> {
  const disk = new IndexedDbMirrorStore({ owner: OWNER, factory, notices: () => null });
  await disk.load();
  const ownerLock = `ohmail.engine.${disk.sharedDiskName()}.${owner}`;
  await disk.commitLocal([{ type: OUTBOX_TYPE, id: `old-${key}`, entity: {
    v: 3, id: `old-${key}`, key, n: 1, at: Date.now(), mutation: SEND, owner: ownerLock, protocol: 1,
  } }], []);
  disk.close();
}
const lockOf = (factory: IDBFactory, owner: string): string => {
  const disk = new IndexedDbMirrorStore({ owner: OWNER, factory, notices: () => null });
  const name = `ohmail.engine.${disk.sharedDiskName()}.${owner}`;
  disk.close();
  return name;
};
/** The owed Cancel as its row on the store says it: the failures counted and the next ask's time. */
const owedOf = (store: MirrorStore): { attempts?: number; nextAt?: number } =>
  store.entries<Row & { attempts?: number; nextAt?: number }>(OUTBOX_TYPE).map((e) => e.entity).find((r) => r.withdrawOwed === true)!;

describe("Cancel across a build seam (H1)", () => {
  beforeAll(() => { (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange ??= FakeKeyRange; });

  it("an older build's send, the server out of reach: no mark, unknown, and its owner keeps its key", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    reg.holdForever(lockOf(factory, "old-tab"));
    await olderBuildRow(factory, "old-tab", "key-old");
    const N = await openIdb(factory, reg.api, srv);
    await until(() => rows(N).some((r) => r.key === "key-old"), "this build reads the older row");
    srv.net.withdrawMode = "unreachable";

    const said = await N.engine.withdrawQueued("key-old");
    const disk = (await diskRows(factory)).find((r) => r.key === "key-old");

    expect(said, "a Cancel over an older build's send said something the server did not").toBe("unknown");
    expect(N.engine.foreignCancelRefused("key-old"), "the web's sentence for it: reload that window").toBe(true);
    expect(disk?.withdrawn, "the older build reads any mark as final and drops a delivered send").toBeUndefined();
  });

  it("the same while the server is reachable: nothing marked, nothing asked; the owning window's replay decides", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    reg.holdForever(lockOf(factory, "old-tab"));
    await olderBuildRow(factory, "old-tab", "key-old");
    srv.ledger.set("key-old", "pending");
    const N = await openIdb(factory, reg.api, srv);
    await until(() => rows(N).some((r) => r.key === "key-old"), "this build reads the older row");

    const said = await N.engine.withdrawQueued("key-old");
    const disk = (await diskRows(factory)).find((r) => r.key === "key-old");

    expect({ said, asked: srv.withdraws.length, marked: disk?.withdrawn ?? false })
      .toEqual({ said: "unknown", asked: 0, marked: false });
  });

  it("a closed older tab's send adopted here may have left: the server out of reach answers unknown", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    await olderBuildRow(factory, "closed-tab", "key-adopted");
    srv.net.offline = true;
    const N = await openIdb(factory, reg.api, srv);
    await until(() => rows(N).some((r) => r.key === "key-adopted" && r.owner !== undefined && r.owner !== lockOf(factory, "closed-tab")), "adopted");

    const said = await N.engine.withdrawQueued("key-adopted");

    expect(said, "a row an older build may have sent was cancelled from here with nobody asked").toBe("unknown");
    expect(srv.deliveries).toHaveLength(0);
  });
});

describe("REVIEW-026 probes as regression cases", () => {
  beforeAll(() => { (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange ??= FakeKeyRange; });

  it("a window whose disk re-read fails reads the wire fact the mark's transaction read: unknown", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    const A = await openIdb(factory, reg.api, srv);
    const B = await openIdb(factory, reg.api, srv);
    srv.net.offline = true;
    const res = await A.engine.mutate(SEND);
    await until(() => rows(B).some((r) => r.key === res.key), "B reads A's row");
    (B.store as unknown as { refreshOutbox: () => Promise<boolean> }).refreshOutbox = async () => { throw new Error("re-read failed"); };
    srv.net.offline = false; srv.net.loseAnswer = true;
    await A.engine.flushPending();
    srv.net.loseAnswer = false;
    const disk = (await diskRows(factory)).find((r) => r.key === res.key);
    const bCopy = rows(B).find((r) => r.key === res.key);
    srv.net.withdrawMode = "unreachable";

    const said = await B.engine.withdrawQueued(res.key);

    expect({ diskWired: disk?.wired, bCopyWired: bCopy?.wired, deliveries: srv.deliveries.length })
      .toEqual({ diskWired: true, bCopyWired: false, deliveries: 1 });
    expect(said, "withdrawn over a delivered send, from a stale copy").toBe("unknown");
  });

  it("in_flight, then the send fails: the ending is the send's failure, so Send is offered again", async () => {
    let at = Date.now();
    const srv = server();
    const store = new MemoryMirrorStore();
    const engine = new OhmailEngine({ adapter: srv.adapter as never, store, now: () => new Date(at) } as never);
    await engine.start().catch(() => undefined);
    srv.net.holdPending = true;
    const res = await engine.mutate(SEND);
    srv.net.holdPending = false;
    const said = await engine.withdrawQueued(res.key);
    srv.ledger.set(res.key, "failed");
    at += 2 * 60 * 60 * 1000; // past the backoff: the next ask is due

    const late: MutationResult[] = await engine.flushPending();
    const ended = late.find((r) => r.key === res.key);

    expect({ said, ended: ended?.status, code: ended?.error?.code, deliveries: srv.deliveries.length })
      .toEqual({ said: "on_the_wire", ended: "rolled_back", code: "send_failed", deliveries: 0 });
  });

  /**
   * OPEN, NOT FIXED (SEND-PRESSED-BEFORE-THE-LOCK-IS-GRANTED): a press before the Web Lock grant writes
   * a row with no owner, and a window opened earlier answers `gone` without asking. Pinned as it is,
   * so the fix that closes the row turns this red and restates it.
   */
  it("a press before the lock grant: the earlier window answers gone without asking (the open row)", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    const B = await openIdb(factory, reg.api, srv);
    reg.setHold(true);
    const A = await openIdb(factory, reg.api, srv);
    srv.net.offline = true;
    const res = await A.engine.mutate(SEND);
    await until(() => rows(B).some((r) => r.key === res.key), "B reads A's row");
    const disk = (await diskRows(factory)).find((r) => r.key === res.key);
    srv.net.offline = false;
    const said = await B.engine.withdrawQueued(res.key);
    reg.setHold(false); reg.release();
    await tick(20);
    await A.engine.flushPending();

    expect({ owner: disk?.owner ?? null, said, deliveries: srv.deliveries.length })
      .toEqual({ owner: null, said: "gone", deliveries: 1 });
  });
});

describe("the wire fact is on disk before the request leaves (LOW 4)", () => {
  beforeAll(() => { (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange ??= FakeKeyRange; });

  it("with a shared disk whose lock is not granted yet, the dispatch writes it", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    reg.setHold(true);
    const A = await openIdb(factory, reg.api, srv);
    const atRequest: Array<boolean | undefined> = [];
    srv.hooks.beforeSend = async (key) => { atRequest.push((await diskRows(factory)).find((r) => r.key === key)?.wired); };

    await A.engine.mutate(SEND);
    await until(() => atRequest.length > 0, "the request left");

    expect(atRequest[0], "the request left with the wire fact in memory only").toBe(true);
    reg.setHold(false); reg.release();
  });

  it("a put the disk refuses sends nothing this round", async () => {
    const srv = server();
    const store = new MemoryMirrorStore();
    const commit = store.commitLocal.bind(store);
    store.commitLocal = (async (puts: Parameters<typeof commit>[0], dels: Parameters<typeof commit>[1]) => {
      if (puts.some((p) => (p.entity as { wired?: boolean } | null)?.wired === true)) throw new Error("QuotaExceededError");
      return commit(puts, dels);
    }) as typeof store.commitLocal;
    const engine = new OhmailEngine({ adapter: srv.adapter as never, store } as never);
    await engine.start().catch(() => undefined);

    const res = await engine.mutate(SEND);

    expect({ status: res.status, deliveries: srv.deliveries.length }).toEqual({ status: "queued", deliveries: 0 });
  });
});

describe("an owed Cancel's limits (LOW 5) and its log (LOW 6)", () => {
  let clock = Date.parse("2026-10-06T00:00:00.000Z");
  const now = (): Date => new Date(clock);
  afterEach(() => { clock = Date.parse("2026-10-06T00:00:00.000Z"); vi.useRealTimers(); });

  /** A delivered send whose answer was lost: wired, so a Cancel the server cannot answer is owed. */
  async function wiredSend(srv: ReturnType<typeof server>, extra: Record<string, unknown> = {}) {
    const store = new MemoryMirrorStore();
    const engine = new OhmailEngine({ adapter: srv.adapter as never, store, now, ...extra } as never);
    await engine.start().catch(() => undefined);
    srv.net.loseAnswer = true;
    const res = await engine.mutate(SEND);
    srv.net.loseAnswer = false;
    return { engine, res, store };
  }

  it("a server's refusal counts and backs off, never shorter than its Retry-After", async () => {
    const srv = server();
    const { engine, res, store } = await wiredSend(srv);
    let asked = 0;
    srv.adapter.withdrawSend = async () => { asked += 1; return { outcome: "unreachable", answered: true, retryAfterMs: 120_000 }; };

    expect(await engine.withdrawQueued(res.key)).toBe("unknown");
    const owed = owedOf(store);
    expect({ attempts: owed.attempts, waits: (owed.nextAt ?? 0) - clock }).toEqual({ attempts: 1, waits: 120_000 });
    clock += 60_000;
    await engine.flushPending();
    expect(asked, "asked again inside the server's own wait").toBe(1);
    clock += 61_000;
    await engine.flushPending();
    expect(asked).toBe(2);
  });

  it("a server's week-long Retry-After waits the outbox's hour, no longer", async () => {
    const srv = server();
    const { engine, res, store } = await wiredSend(srv);
    let asked = 0;
    srv.adapter.withdrawSend = async () => { asked += 1; return { outcome: "unreachable", answered: true, retryAfterMs: 7 * 24 * 3_600_000 }; };

    await engine.withdrawQueued(res.key);
    const owed = owedOf(store);
    expect((owed.nextAt ?? 0) - clock, "the composer held for as long as a server asked").toBe(OUTBOX_BACKOFF_CAP_MS);
    clock += OUTBOX_BACKOFF_CAP_MS + 1;
    await engine.flushPending();
    expect(asked).toBe(2);
  });

  it("past the ceiling the Cancel ends unconfirmed in the strip, never withdrawn", async () => {
    const srv = server();
    const { engine, res, store } = await wiredSend(srv);
    srv.adapter.withdrawSend = async () => ({ outcome: "unsupported" });
    await engine.withdrawQueued(res.key);
    let ended: MutationResult | undefined;
    for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES + 2 && ended === undefined; i++) {
      clock += 3_600_001;
      ended = (await engine.flushPending()).find((r) => r.key === res.key);
    }
    expect({ status: ended?.status, code: ended?.error?.code, strip: engine.abandoned().map((a) => a.key) })
      .toEqual({ status: "rolled_back", code: "send_unverified", strip: [res.key] });
  });

  it("no connection at all does not count and is asked again on the next flush", async () => {
    const srv = server();
    const { engine, res, store } = await wiredSend(srv);
    let asked = 0;
    srv.adapter.withdrawSend = async () => { asked += 1; return { outcome: "unreachable" }; };
    await engine.withdrawQueued(res.key);
    const owed = owedOf(store);
    expect({ attempts: owed.attempts ?? 0, nextAt: owed.nextAt }).toEqual({ attempts: 0, nextAt: undefined });
    await engine.flushPending();
    expect(asked).toBe(2);
  });

  it("the adapter asks under a deadline and reads the server's Retry-After", async () => {
    vi.useFakeTimers();
    const stalled = new HttpAdapter({ baseUrl: "http://host.test", fetch: (() => new Promise<Response>(() => undefined)) as never });
    const pending = stalled.withdrawSend("key-1", null);
    await vi.advanceTimersByTimeAsync(WITHDRAW_SEND_TIMEOUT_MS + 1);
    await expect(pending).resolves.toEqual({ outcome: "unreachable" });
    vi.useRealTimers();
    const busy = new HttpAdapter({ baseUrl: "http://host.test", fetch: (async () => new Response("", { status: 503, headers: { "retry-after": "2" } })) as never });
    await expect(busy.withdrawSend("key-1", null)).resolves.toEqual({ outcome: "unreachable", answered: true, retryAfterMs: 2000 });
    const old = new HttpAdapter({ baseUrl: "http://host.test", fetch: (async () => new Response("", { status: 404 })) as never });
    await expect(old.withdrawSend("key-1", null)).resolves.toEqual({ outcome: "unsupported" });
  });

  it("a server without the route is said once per send, on the local answer and on every re-ask", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange ??= FakeKeyRange;
    let said = 0;
    srv.adapter.withdrawSend = async () => ({ outcome: "unsupported" });
    const store = new IndexedDbMirrorStore({ owner: OWNER, factory });
    const engine = new OhmailEngine({ adapter: srv.adapter as never, store, locks: reg.api, now, onWithdrawUnsupported: () => { said += 1; } } as never);
    await engine.start().catch(() => undefined);
    await until(() => reg.held.size === 1, "the owning engine's lock");
    srv.net.offline = true;
    const neverSent = await engine.mutate(SEND);
    const another = await engine.mutate({ ...SEND, body: "A second note." } as never);
    srv.net.offline = false;

    expect(await engine.withdrawQueued(neverSent.key)).toBe("withdrawn");
    expect(await engine.withdrawQueued(another.key)).toBe("withdrawn");
    expect(said, "the never-sent local answer logged nothing").toBe(2);

    srv.net.loseAnswer = true;
    const wired = await engine.mutate({ ...SEND, body: "A third note." } as never);
    srv.net.loseAnswer = false;
    expect(await engine.withdrawQueued(wired.key)).toBe("unknown");
    clock += 3_600_001;
    await engine.flushPending();
    expect(said, "once per send, owed re-asks included").toBe(3);
  });
});
