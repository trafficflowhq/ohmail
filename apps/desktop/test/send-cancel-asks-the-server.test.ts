/**
 * CANCEL'S ANSWER COMES FROM THE SERVER. A send whose answer
 * was lost reads unclaimed on every disk, so a Cancel decided by the disk alone said "withdrawn"
 * over a delivery. The double below is the send route and the withdraw route over one ledger: a
 * key it holds answers `already_sent` (or `in_flight` while held), a key it never saw is tombstoned
 * and refused at the wire. `withdrawMode` makes the withdraw unreachable or a server without it.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { IDBFactory, IDBKeyRange as FakeKeyRange } from "fake-indexeddb";
import {
  carriedOutboxMarks, HttpAdapter, IndexedDbMirrorStore, MemoryMirrorStore, MutationRejectedError, OhmailEngine,
  OUTBOX_ABANDONED_TYPE, OUTBOX_MAX_SERVER_FAILURES, OUTBOX_TYPE, OUTBOX_WITHDRAWN_CODE,
  type EngineLocks, type EngineMutation, type MirrorStore, type MutationResult,
} from "@ohmail/client-engine";
import { HostOutboxStore } from "../src/host-client/outbox-store.js";

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

type WithdrawMode = "ledger" | "unreachable" | "unsupported";

/** The server: one ledger under the send route and the withdraw route, as `outbound_sends` is. */
function server() {
  const ledger = new Map<string, "sent" | "pending" | "withdrawn">();
  const deliveries: string[] = [];
  const sends: string[] = [];
  const withdraws: Array<{ key: string; draftId: string | null }> = [];
  const net = { offline: false, loseAnswer: false, holdPending: false, withdrawMode: "ledger" as WithdrawMode };
  // The browser's own word on the network, as a claim reads it: offline sends nothing, no wire fact.
  Object.defineProperty(globalThis.navigator, "onLine", { get: () => !net.offline, configurable: true });
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
      sends.push(o.idempotencyKey);
      const held = ledger.get(o.idempotencyKey);
      if (held === "withdrawn") throw new MutationRejectedError("This send was cancelled before it left; nothing was sent.", { status: 409, code: OUTBOX_WITHDRAWN_CODE, retryable: false });
      if (held === "sent") return { changes: [], seq: null, firstSend: { status: "sent", at: new Date().toISOString() } };
      if (held === "pending") throw new MutationRejectedError("A send for this draft is already in progress.", { status: 409, code: "send_in_flight", retryable: true });
      deliveries.push(o.idempotencyKey);
      ledger.set(o.idempotencyKey, net.holdPending ? "pending" : "sent");
      // THE LOST ANSWER: the server took it, the connection dropped before the client read it.
      if (net.loseAnswer || net.holdPending) throw new MutationRejectedError("network failure: socket hang up", { code: "network", retryable: true });
      return { changes: [], seq: null };
    },
    withdrawSend: async (key: string, draftId: string | null) => {
      if (net.offline || net.withdrawMode === "unreachable") return { outcome: "unreachable" as const };
      if (net.withdrawMode === "unsupported") return { outcome: "unsupported" as const };
      withdraws.push({ key, draftId });
      const held = ledger.get(key);
      if (held === "sent") return { outcome: "already_sent" as const, firstSend: { status: "sent", at: new Date().toISOString() } };
      if (held === "pending") return { outcome: "in_flight" as const };
      ledger.set(key, "withdrawn");
      return { outcome: "withdrawn" as const };
    },
  };
  return { adapter, net, deliveries, sends, withdraws, ledger };
}

const SEND = {
  kind: "mail_send", inReplyTo: "m-1", body: "Thanks, Ada.", subject: "Re: Invoice", mailboxId: "mb-1",
  to: [{ name: "Ada", address: "ada@fake.test" }],
} as unknown as EngineMutation;

type Tab = { store: MirrorStore; engine: OhmailEngine };
async function openIdb(
  factory: IDBFactory, locks: EngineLocks | null, srv: ReturnType<typeof server>,
  store: IndexedDbMirrorStore = new IndexedDbMirrorStore({ owner: "acct-cancel", factory }),
): Promise<Tab> {
  const engine = new OhmailEngine({ adapter: srv.adapter as never, store, locks } as never);
  await engine.start().catch(() => undefined);
  return { store, engine };
}
async function openMemory(srv: ReturnType<typeof server>, now?: () => Date): Promise<Tab> {
  const store = new MemoryMirrorStore();
  const engine = new OhmailEngine({ adapter: srv.adapter as never, store, ...(now ? { now } : {}) } as never);
  await engine.start().catch(() => undefined);
  return { store, engine };
}
/** The paired page's store fallen back to memory: every claim on the disk row is answered `gone`. */
class ClaimFindsNothing extends IndexedDbMirrorStore {
  override async decideOutboxRow(...a: Parameters<IndexedDbMirrorStore["decideOutboxRow"]>) {
    return a[1].kind === "claim" ? "gone" as const : super.decideOutboxRow(...a);
  }
}
type Row = { key: string; owner?: string; withdrawn?: boolean; sending?: string; wired?: boolean; withdrawOwed?: boolean };
const rows = (t: Tab) => t.store.entries<Row>(OUTBOX_TYPE).map((e) => e.entity);
async function diskRows(factory: IDBFactory): Promise<Row[]> {
  const probe = new IndexedDbMirrorStore({ owner: "acct-cancel", factory, notices: () => null });
  await probe.load();
  const out = probe.entries<Row>(OUTBOX_TYPE).map((e) => e.entity);
  probe.close();
  return out;
}

describe("a send whose answer was lost: Cancel asks the server", () => {
  beforeAll(() => { (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange ??= FakeKeyRange; });
  afterEach(() => { Object.defineProperty(globalThis.navigator, "onLine", { get: () => true, configurable: true }); });

  it("HIGH, one window: delivered, answer lost, Cancel says on its way and the send ends sent, once", async () => {
    const srv = server();
    const A = await openMemory(srv);
    srv.net.loseAnswer = true;
    const res = await A.engine.mutate(SEND);
    srv.net.loseAnswer = false;
    const outcome = await A.engine.withdrawQueued(res.key);
    const late: MutationResult[] = await A.engine.flushPending();
    const ended = late.find((r) => r.key === res.key);
    expect({ queued: res.status, outcome, deliveries: srv.deliveries.length, asked: srv.withdraws.length, ended: ended?.status, first: ended?.firstSend?.status, rows: rows(A).length })
      .toEqual({ queued: "queued", outcome: "on_the_wire", deliveries: 1, asked: 1, ended: "confirmed", first: "sent", rows: 0 });
  });

  it("HIGH, second window: A's answer lost after delivery, B's Cancel says on its way; A's replay is answered from the reservation", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    const A = await openIdb(factory, reg.api, srv);
    const B = await openIdb(factory, reg.api, srv);
    srv.net.loseAnswer = true;
    const res = await A.engine.mutate(SEND);
    srv.net.loseAnswer = false;
    await until(() => rows(B).some((r) => r.key === res.key && r.sending === undefined), "B reads A's re-queued row");
    const outcome = await B.engine.withdrawQueued(res.key);
    const marked = (await diskRows(factory)).some((r) => r.withdrawn === true);
    const late = await A.engine.flushPending();
    expect({ queued: res.status, outcome, marked, deliveries: srv.deliveries.length, asked: srv.withdraws.length, replay: late.find((r) => r.key === res.key)?.firstSend?.status })
      .toEqual({ queued: "queued", outcome: "on_the_wire", marked: false, deliveries: 1, asked: 1, replay: "sent" });
  });

  it("B: offline Send leaves no wire fact; offline Cancel withdraws, owed; online the server tombstones it and the key never sends", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    const A = await openIdb(factory, reg.api, srv);
    srv.net.offline = true;
    const res = await A.engine.mutate(SEND);
    const disk = (await diskRows(factory))[0];
    const outcome = await A.engine.withdrawQueued(res.key);
    const owed = (await diskRows(factory))[0];
    srv.net.offline = false;
    await A.engine.syncOnce();
    const replay = await srv.adapter.mutate(SEND, { idempotencyKey: res.key }).then(() => "answered", (e: MutationRejectedError) => e.code);
    expect({
      queued: res.status, wired: disk?.wired ?? false, outcome, owed: [owed?.withdrawn, owed?.withdrawOwed],
      tomb: srv.ledger.get(res.key), replay, deliveries: srv.deliveries.length, sends: srv.sends.length - 1,
      after: (await diskRows(factory)).map((r) => [r.withdrawn, r.withdrawOwed ?? false]),
    }).toEqual({
      queued: "queued", wired: false, outcome: "withdrawn", owed: [true, true],
      tomb: "withdrawn", replay: OUTBOX_WITHDRAWN_CODE, deliveries: 0, sends: 0, after: [[true, false]],
    });
  });

  it("RISK 1: a Cancel owed across a restart is asked by the first drive and its send is never dispatched", async () => {
    const factory = new IDBFactory(); const srv = server();
    const A = await openIdb(factory, null, srv);
    srv.net.loseAnswer = true;
    const res = await A.engine.mutate(SEND);
    srv.net.loseAnswer = false;
    srv.net.withdrawMode = "unreachable";
    const said = await A.engine.withdrawQueued(res.key);
    (A.store as IndexedDbMirrorStore).close();
    const sendsBefore = srv.sends.length;
    srv.net.withdrawMode = "ledger";
    const B = await openIdb(factory, null, srv);
    await B.engine.syncOnce();
    const late = await B.engine.flushPending();
    expect({ said, asked: srv.withdraws.map((w) => w.key), sendsAfterRestart: srv.sends.length - sendsBefore, ended: late.find((r) => r.key === res.key)?.status, rows: (await diskRows(factory)).length })
      .toEqual({ said: "unknown", asked: [res.key], sendsAfterRestart: 0, ended: "confirmed", rows: 0 });
  });

  it("a wired row the server cannot answer for is unknown, never withdrawn; a never-wired one is withdrawn and owed", async () => {
    const srv = server();
    const A = await openMemory(srv);
    srv.net.loseAnswer = true;
    const wired = await A.engine.mutate(SEND);
    srv.net.loseAnswer = false;
    srv.net.withdrawMode = "unreachable";
    const a = await A.engine.withdrawQueued(wired.key);
    const factory = new IDBFactory(); const reg = registry(); const srv2 = server();
    const B = await openIdb(factory, reg.api, srv2);
    srv2.net.offline = true;
    const quiet = await B.engine.mutate(SEND);
    const b = await B.engine.withdrawQueued(quiet.key);
    expect({ a, aOwed: rows(A).map((r) => [r.withdrawn, r.withdrawOwed]), b, bOwed: (await diskRows(factory)).map((r) => [r.withdrawn, r.withdrawOwed]), answer: A.engine.withdrawAnswerOf(wired.key) })
      .toEqual({ a: "unknown", aOwed: [[true, true]], b: "withdrawn", bOwed: [[true, true]], answer: "unreachable" });
  });

  it("a server without the route: unknown over a wired row (owed), the local answer over a row that never left", async () => {
    const srv = server();
    const A = await openMemory(srv);
    srv.net.loseAnswer = true;
    const wired = await A.engine.mutate(SEND);
    srv.net.loseAnswer = false;
    srv.net.withdrawMode = "unsupported";
    const a = await A.engine.withdrawQueued(wired.key);
    const factory = new IDBFactory(); const reg = registry(); const srv2 = server();
    const B = await openIdb(factory, reg.api, srv2);
    srv2.net.offline = true;
    const quiet = await B.engine.mutate(SEND);
    srv2.net.offline = false;
    srv2.net.withdrawMode = "unsupported";
    const b = await B.engine.withdrawQueued(quiet.key);
    expect({ a, aOwed: rows(A).map((r) => r.withdrawOwed), b, bRows: (await diskRows(factory)).map((r) => [r.withdrawn, r.withdrawOwed ?? false]) })
      .toEqual({ a: "unknown", aOwed: [true], b: "withdrawn", bRows: [[true, false]] });
  });

  it("in_flight: on its way, the row stays owed, and the drive re-asks the WITHDRAW until it settles — never the send", async () => {
    let now = Date.now();
    const srv = server();
    const A = await openMemory(srv, () => new Date(now));
    srv.net.holdPending = true;
    const res = await A.engine.mutate(SEND);
    srv.net.holdPending = false;
    const outcome = await A.engine.withdrawQueued(res.key);
    const owed = rows(A).map((r) => [r.withdrawn, r.withdrawOwed]);
    const sendsBefore = srv.sends.length;
    // Past the backoff: the next ask is due.
    now += 2 * 60 * 60 * 1000;
    srv.ledger.set(res.key, "sent");
    const late = await A.engine.flushPending();
    expect({ outcome, owed, asked: srv.withdraws.length, sends: srv.sends.length - sendsBefore, ended: late.find((r) => r.key === res.key)?.status, deliveries: srv.deliveries.length })
      .toEqual({ outcome: "on_the_wire", owed: [[true, true]], asked: 2, sends: 0, ended: "confirmed", deliveries: 1 });
  });

  it("RISK 5: an owed Cancel that never settles ends in the abandoned strip unconfirmed, and Try again asks the withdraw", async () => {
    let now = Date.now();
    const srv = server();
    const store = new MemoryMirrorStore();
    const engine = new OhmailEngine({ adapter: srv.adapter as never, store, now: () => new Date(now) } as never);
    await engine.start().catch(() => undefined);
    srv.net.holdPending = true;
    const res = await engine.mutate(SEND);
    srv.net.holdPending = false;
    await engine.withdrawQueued(res.key);
    for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES + 2 && store.entries(OUTBOX_ABANDONED_TYPE).length === 0; i++) {
      now += 2 * 60 * 60 * 1000;
      await engine.flushPending();
    }
    const strip = engine.abandoned().find((a) => a.key === res.key);
    const sendsBefore = srv.sends.length;
    const askedBefore = srv.withdraws.length;
    srv.ledger.set(res.key, "sent");
    const retried = await engine.retryAbandoned(strip!.id);
    expect({ code: strip?.error.code, retryable: strip?.retryable, live: store.entries(OUTBOX_TYPE).length, retried: retried.status, sends: srv.sends.length - sendsBefore, asked: srv.withdraws.length - askedBefore })
      .toEqual({ code: "send_unverified", retryable: true, live: 0, retried: "confirmed", sends: 0, asked: 1 });
  });

  it("a claim that finds its shared row gone still sends knowing it left: the Cancel the server cannot answer is unknown", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    const A = await openIdb(factory, reg.api, srv, new ClaimFindsNothing({ owner: "acct-cancel", factory }));
    srv.net.loseAnswer = true;
    const res = await A.engine.mutate(SEND);
    srv.net.loseAnswer = false;
    srv.net.withdrawMode = "unreachable";
    const said = await A.engine.withdrawQueued(res.key);
    expect({ deliveries: srv.deliveries.length, said }).toEqual({ deliveries: 1, said: "unknown" });
  });

  it("the notice carries the server's answer: posted after it, and the owning window ends its copy with that word only", async () => {
    const factory = new IDBFactory(); const reg = registry(); const srv = server();
    const A = await openIdb(factory, reg.api, srv);
    const B = await openIdb(factory, reg.api, srv);
    srv.net.offline = true;
    const res = await A.engine.mutate(SEND);
    await until(() => rows(B).some((r) => r.key === res.key), "B reads A's row");
    srv.net.offline = false;
    const said = await B.engine.withdrawQueued(res.key);
    await until(() => A.engine.pendingMutations().length === 0, "A ends its copy on the server's word");
    const late = await A.engine.flushPending();
    expect({ said, asked: srv.withdraws.length, code: late.find((r) => r.key === res.key)?.error?.code, deliveries: srv.deliveries.length })
      .toEqual({ said: "withdrawn", asked: 1, code: OUTBOX_WITHDRAWN_CODE, deliveries: 0 });
  });
});

describe("the adapter asks on the send's own door, and every answer it cannot read is unreachable", () => {
  const SEND_ROW = { ...(SEND as object), draftId: "11111111-1111-4111-8111-111111111111" } as unknown as EngineMutation;
  function door(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const seen: Array<{ url: string; method: string; key: string | null; body: string | null }> = [];
    const fetch = async (url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      seen.push({ url, method: init.method ?? "GET", key: headers["idempotency-key"] ?? null, body: typeof init.body === "string" ? init.body : null });
      return answer(url, init);
    };
    return { adapter: new HttpAdapter({ baseUrl: "https://door.test/api", fetch: fetch as never }), seen };
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("the withdraw goes to the base the send went to, key in the header, never in the path", async () => {
    const { adapter, seen } = door((url) => url.endsWith("/send") ? json(200, { status: "sent", providerMessageId: "<p@x>" })
      : url.endsWith("/sends/withdraw") ? json(200, { outcome: "already_sent", firstSend: { status: "sent", at: "2026-10-05T12:00:00.000Z" } })
        : json(200, { id: "11111111-1111-4111-8111-111111111111", revision: "r1", mailboxId: "mb-1" }));
    await adapter.mutate(SEND_ROW, { idempotencyKey: "K-door" });
    const answer = await adapter.withdrawSend("K-door", "11111111-1111-4111-8111-111111111111");
    const send = seen.find((r) => r.url.endsWith("/send"))!;
    const withdraw = seen.find((r) => r.url.endsWith("/sends/withdraw"))!;
    expect({
      sendBase: send.url.slice(0, send.url.indexOf("/drafts/")), withdraw: withdraw.url, method: withdraw.method,
      key: withdraw.key, inPath: withdraw.url.includes("K-door"), body: JSON.parse(withdraw.body!), answer,
    }).toEqual({
      sendBase: "https://door.test/api", withdraw: "https://door.test/api/sends/withdraw", method: "POST",
      key: "K-door", inPath: false, body: { draftId: "11111111-1111-4111-8111-111111111111" },
      answer: { outcome: "already_sent", firstSend: { status: "sent", at: "2026-10-05T12:00:00.000Z" } },
    });
  });

  it("404 is a server without the route; a 5xx, a throw, an unreadable or foreign answer are unreachable", async () => {
    const ask = async (answer: () => Response | Promise<Response>) => door(() => answer()).adapter.withdrawSend("K", null);
    expect({
      missing: await ask(() => json(404, { error: { code: "not_found", message: "no such route" } })),
      down: await ask(() => json(503, { error: { code: "db_busy", message: "busy" } })),
      thrown: await ask(() => { throw new TypeError("fetch failed"); }),
      garbage: await ask(() => new Response("<html>", { status: 200 })),
      foreign: await ask(() => json(200, { outcome: "cancelled" })),
      refused: await ask(() => json(401, { error: { code: "unauthorized", message: "no session" } })),
    }).toEqual({
      // A server that answered without deciding counts toward an owed Cancel's ceiling; no answer does not.
      missing: { outcome: "unsupported" }, down: { outcome: "unreachable", answered: true }, thrown: { outcome: "unreachable" },
      garbage: { outcome: "unreachable", answered: true }, foreign: { outcome: "unreachable", answered: true },
      refused: { outcome: "unreachable" },
    });
  });

  it("the send's 409 send_withdrawn is the withdrawn ending: terminal, the withdrawn code", async () => {
    const { adapter } = door((url) => url.endsWith("/send")
      ? json(409, { error: { code: "send_withdrawn", message: "This send was cancelled before it left; nothing was sent.", retryable: false } })
      : json(200, { id: "11111111-1111-4111-8111-111111111111", revision: "r1", mailboxId: "mb-1" }));
    const err = await adapter.mutate(SEND_ROW, { idempotencyKey: "K-tomb" }).then(() => null, (e: MutationRejectedError) => e);
    expect({ code: err?.code, retryable: err?.retryable }).toEqual({ code: OUTBOX_WITHDRAWN_CODE, retryable: false });
  });
});

describe("a later put of a row never takes back a Cancel's mark, its debt or the wire fact — both stores", () => {
  beforeAll(() => { (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange ??= FakeKeyRange; });
  const ROW = { v: 3, id: "r-1", key: "K", n: 0, at: 1, mutation: { kind: "mail_send" } };

  it("the rule: carried over a stale put; an answered write clears the debt; nothing to carry is null", () => {
    expect({
      stale: carriedOutboxMarks({ ...ROW }, { ...ROW, withdrawn: true, withdrawOwed: true, wired: true }),
      answered: carriedOutboxMarks({ ...ROW, withdrawn: true }, { ...ROW, withdrawn: true, withdrawOwed: true }),
      nothing: carriedOutboxMarks({ ...ROW, wired: true }, { ...ROW }),
      noPrior: carriedOutboxMarks({ ...ROW }, null),
    }).toEqual({
      stale: { ...ROW, withdrawn: true, withdrawOwed: true, wired: true },
      answered: null, nothing: null, noPrior: null,
    });
  });

  it("the web's IndexedDB store and the paired page's store both keep the mark, the debt and the wire fact", async () => {
    const marked = { ...ROW, withdrawn: true, withdrawOwed: true, wired: true };
    const read = async (open: () => Promise<{ entries: (t: string) => Array<{ entity: unknown }> } & { close?: () => void }>) => {
      const s = await open();
      const out = s.entries(OUTBOX_TYPE).map((e) => e.entity);
      s.close?.();
      return out;
    };
    const idbFactory = new IDBFactory();
    const idb = new IndexedDbMirrorStore({ owner: "acct-carry", factory: idbFactory, notices: () => null });
    await idb.load();
    await idb.commitLocal([{ type: OUTBOX_TYPE, id: "r-1", entity: marked }], []);
    await idb.commitLocal([{ type: OUTBOX_TYPE, id: "r-1", entity: { ...ROW, attempts: 1 } }], []);
    idb.close();
    const web = await read(async () => {
      const s = new IndexedDbMirrorStore({ owner: "acct-carry", factory: idbFactory, notices: () => null });
      await s.load();
      return s;
    });
    const hostFactory = new IDBFactory();
    const host = new HostOutboxStore({ scope: "pair-carry", live: () => true, factory: hostFactory, notices: () => null });
    await host.load();
    await host.commitLocal([{ type: OUTBOX_TYPE, id: "r-1", entity: marked }], []);
    await host.commitLocal([{ type: OUTBOX_TYPE, id: "r-1", entity: { ...ROW, attempts: 1 } }], []);
    const paired = await read(async () => {
      const s = new HostOutboxStore({ scope: "pair-carry", live: () => true, factory: hostFactory, notices: () => null });
      await s.load();
      return s;
    });
    const marks = (rows: unknown[]) => rows.map((r) => {
      const e = r as { withdrawn?: boolean; withdrawOwed?: boolean; wired?: boolean; attempts?: number };
      return [e.withdrawn ?? false, e.withdrawOwed ?? false, e.wired ?? false, e.attempts ?? 0];
    });
    expect({ web: marks(web), paired: marks(paired) }).toEqual({ web: [[true, true, true, 1]], paired: [[true, true, true, 1]] });
  });
});
