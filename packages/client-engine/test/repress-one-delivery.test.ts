/**
 * ONE INTENT, ONE KEY, ONE DELIVERY on the engine's own roads (PRE-1).
 * The phone file drives the press; this one drives what the phone never runs and what only a
 * store can say: the boot replay with auto-replay on, a refused replacement mid-flush, a send
 * that outran its deadline, and Try again's row after a kill (LOW-4).
 */
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  IndexedDbMirrorStore, MutationRejectedError, OhmailEngine, OUTBOX_ABANDONED_TYPE, OUTBOX_TYPE, OUTBOX_WITHDRAWN_CODE,
  OUTBOX_BACKOFF_CAP_MS, OUTBOX_MAX_SERVER_FAILURES,
  type EngineMutation, type MutationResult, type SendAndDonePlan,
} from "@ohmail/client-engine";

const NOW = Date.parse("2026-10-02T08:00:00.000Z");
const tick = (): Promise<void> => new Promise<void>((r) => { setTimeout(r, 5); });
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await tick();
  if (!cond()) throw new Error(`never reached: ${what}`);
}
const send = (to: string, body: string): EngineMutation => ({
  kind: "mail_send", inReplyTo: null, mailboxId: "mb", subject: `For ${to}`, body,
  to: [{ name: null, address: `${to}@fake.test` }], cc: [], bcc: [],
} as unknown as EngineMutation);

type Fate = "ok" | "offline" | "hold" | "hang" | "fail500" | "holdfail";
/**
 * The send route as the server keeps it: one row per key (the create is idempotent), one
 * reservation per key (a second send under a delivered key answers from it with `firstSend`).
 * `plan` decides the next attempts in order; `mode` every attempt after the plan runs out.
 */
function server() {
  const attempts: string[] = [];
  const delivered = new Set<string>();
  const rows = new Map<string, string>();
  const plan: Fate[] = [];
  const net = { mode: "ok" as Fate };
  let open: (() => void) | null = null;
  const adapter = {
    sync: async () => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "1", hasMore: false, serverTime: new Date(NOW).toISOString(),
    }),
    fetchBody: async () => null,
    mutate: async (m: EngineMutation, opts: {
      idempotencyKey: string; createdRow?: { id: string }; onDraftRow?: (r: { id: string; revision: string | null }) => Promise<void>;
    }) => {
      if (m.kind !== "mail_send") return { changes: [], seq: null };
      const key = opts.idempotencyKey;
      if (!rows.has(key) && opts.createdRow === undefined) {
        rows.set(key, `row-${rows.size + 1}`);
        await opts.onDraftRow?.({ id: rows.get(key)!, revision: null });
      }
      attempts.push(key);
      const fate = plan.shift() ?? net.mode;
      if (fate === "offline") throw new MutationRejectedError("network failure", { code: "network", retryable: true });
      if (fate === "fail500") throw new MutationRejectedError("internal", { status: 500, code: "internal", retryable: true });
      if (fate === "hang") await new Promise<void>(() => { /* never answered */ });
      if (fate === "hold" || fate === "holdfail") await new Promise<void>((r) => { open = r; });
      if (fate === "holdfail") throw new MutationRejectedError("network failure", { code: "network", retryable: true });
      if (delivered.has(key)) {
        return { changes: [], seq: null, entityId: rows.get(key), firstSend: { status: "sent", at: new Date(NOW).toISOString() } };
      }
      delivered.add(key);
      return { changes: [], seq: null, entityId: rows.get(key), providerMessageId: `<${key}@x>` };
    },
  };
  return {
    adapter, attempts, delivered, rows, plan, net,
    release: () => { const r = open; open = null; r?.(); },
    sendsUnder: (key: string) => attempts.filter((k) => k === key).length,
  };
}
type Srv = ReturnType<typeof server>;

async function openStore(factory: IDBFactory, owner: string): Promise<IndexedDbMirrorStore> {
  const store = new IndexedDbMirrorStore({ owner, factory });
  await store.load();
  return store;
}
const engineOn = (store: IndexedDbMirrorStore, srv: Srv, opts: { autoReplay?: boolean; deadlineMs?: number; clock?: { t: number } } = {}) =>
  new OhmailEngine({
    store, adapter: srv.adapter as never,
    now: () => new Date(opts.clock?.t ?? NOW),
    ...(opts.autoReplay === false ? { outboxAutoReplay: false } : {}),
    ...(opts.deadlineMs !== undefined ? { outboxReplayDeadlineMs: opts.deadlineMs } : {}),
  } as never);

/** Two sends queued by an unreachable server, each having made its row: Ada's first. */
async function twoQueued(srv: Srv, store: IndexedDbMirrorStore, autoReplay = false) {
  const e = engineOn(store, srv, { autoReplay });
  await e.start();
  srv.net.mode = "offline";
  const a = await e.mutate(send("ada", "first"));
  const b = await e.mutate(send("bo", "second"));
  expect([a.status, b.status]).toEqual(["queued", "queued"]);
  srv.net.mode = "ok";
  return { e, a, b };
}

describe("a same-key press while a batch is on the wire", () => {
  it("the boot replay (auto-replay on): the restored tail is retired and goes once", async () => {
    const factory = new IDBFactory();
    const srv = server();
    const s1 = await openStore(factory, "acct-repress-replay");
    const { a, b } = await twoQueued(srv, s1);
    s1.close();

    srv.plan.push("hold");
    const s2 = await openStore(factory, "acct-repress-replay");
    const e2 = engineOn(s2, srv);
    void e2.start();
    await until(() => srv.attempts.filter((k) => k === a.key).length === 2, "the restored head on the wire");
    const tail = e2.pendingMutations().find((p) => p.key === b.key);
    expect(tail, "the replay's tail is invisible while its head is on the wire").toBeDefined();
    const again = e2.mutate(tail!.mutation, { key: b.key });
    srv.release();
    expect((await again).status).toBe("confirmed");
    await until(() => srv.delivered.size === 2, "both delivered");
    expect(srv.sendsUnder(b.key) - 1, "the retired tail went to the wire as well").toBe(1);
    expect(srv.rows.size, "a second row was made").toBe(2);
    expect(e2.pendingMutations()).toHaveLength(0);
    s2.close();
  }, 20_000);

  it("the boot replay, the restored send failing on the wire after the re-press: one delivery, no answer left over", async () => {
    const factory = new IDBFactory();
    const srv = server();
    const s1 = await openStore(factory, "acct-repress-replay-fail");
    const { a } = await twoQueued(srv, s1);
    s1.close();

    srv.plan.push("holdfail");
    const s2 = await openStore(factory, "acct-repress-replay-fail");
    const e2 = engineOn(s2, srv);
    void e2.start();
    await until(() => srv.attempts.filter((k) => k === a.key).length === 2, "the restored head on the wire");
    const head = e2.inFlightMutations().find((p) => p.key === a.key)!;
    const again = e2.mutate(head.mutation, { key: a.key });
    srv.release();
    expect((await again).status).toBe("confirmed");
    await until(() => srv.delivered.size === 2, "both delivered");
    // The other restored send's answer is kept for the surface; the superseded one is not.
    const handed = await e2.flushPending();
    expect(handed.filter((r) => r.key === a.key).map((r) => r.status), "a superseded answer was kept for a reader that does not exist").toEqual([]);
    expect(srv.sendsUnder(a.key) - 1, "the superseded send was sent again").toBe(2);
    s2.close();
  }, 20_000);

  it("a refused replacement mid-flush puts the tail back and the flush sends it at its turn, once", async () => {
    const srv = server();
    const store = await openStore(new IDBFactory(), "acct-repress-undo");
    const { e, b } = await twoQueued(srv, store);
    srv.plan.push("hold");
    const flush = e.flushPending();
    await until(() => srv.attempts.length === 3, "the head on the wire");
    const commit = store.commitLocal.bind(store);
    let refuse = true;
    store.commitLocal = (async (...args: Parameters<typeof commit>) => {
      if (refuse) { refuse = false; throw new Error("QuotaExceededError"); }
      return commit(...args);
    }) as typeof store.commitLocal;
    const tail = e.pendingMutations().find((p) => p.key === b.key)!;
    const again = await e.mutate(tail.mutation, { key: b.key });
    expect(again.status).toBe("rolled_back");
    expect(again.error?.code).toBe("storage_refused");
    expect(e.pendingMutations().map((p) => p.key), "the refused replacement lost the tail").toEqual([b.key]);
    srv.release();
    const results = await flush;
    expect(results.find((r) => r.key === b.key)?.status).toBe("confirmed");
    expect(srv.delivered.has(b.key)).toBe(true);
    expect(srv.sendsUnder(b.key) - 1).toBe(1);
    store.close();
  }, 20_000);

  it("a send past its deadline, re-pressed under its key: one delivery, and nothing said as refused", async () => {
    const srv = server();
    const store = await openStore(new IDBFactory(), "acct-repress-late");
    const e = engineOn(store, srv, { autoReplay: false, deadlineMs: 60 });
    await e.start();
    srv.net.mode = "offline";
    const pressed = send("ada", "first");
    const a = await e.mutate(pressed);
    srv.net.mode = "ok";
    srv.plan.push("hold");
    const first = await e.flushPending();
    expect(first.map((r) => r.status), "the timed-out send was not answered queued").toEqual(["queued"]);
    const again = await e.mutate(pressed, { key: a.key });
    expect(again.status, "the re-press went past the barrier").toBe("queued");
    srv.release();
    // The older confirms SILENTLY: a newer press stands under its key and speaks for it (one speaker).
    await until(() => e.inFlightMutations().length === 0, "the late attempt settled");
    expect(e.hasLateResults(), "the superseded confirmation was kept as a second speaker").toBe(false);
    const later: MutationResult[] = [];
    for (let i = 0; i < 5 && e.pendingMutations().length + (e.hasLateResults() ? 1 : 0) > 0; i++) later.push(...await e.flushPending());
    expect(srv.delivered.size).toBe(1);
    expect(later.filter((r) => r.key === a.key).map((r) => r.status)).toEqual(["confirmed"]);
    store.close();
  }, 20_000);
});

describe("a send past its deadline that then fails, re-pressed under its key", () => {
  it("one delivery by the newer, and the older's late answer is kept for nobody", async () => {
    const srv = server();
    const store = await openStore(new IDBFactory(), "acct-repress-late-fail");
    const e = engineOn(store, srv, { autoReplay: false, deadlineMs: 60 });
    await e.start();
    srv.net.mode = "offline";
    const pressed = send("ada", "first");
    const a = await e.mutate(pressed);
    srv.net.mode = "ok";
    srv.plan.push("holdfail");
    expect((await e.flushPending()).map((r) => r.status)).toEqual(["queued"]);
    expect((await e.mutate(pressed, { key: a.key })).status).toBe("queued");
    srv.release();
    await until(() => e.inFlightMutations().length === 0, "the late attempt settled");
    expect(e.hasLateResults(), "a superseded late answer was kept for a reader that does not exist").toBe(false);
    const later = await e.flushPending();
    expect(later.map((r) => r.status)).toEqual(["confirmed"]);
    expect(srv.delivered.size).toBe(1);
    store.close();
  }, 20_000);
});

describe("a refused replacement over a send on the wire", () => {
  it("takes its mark back: the older still goes, once, when its wire attempt fails", async () => {
    const srv = server();
    const store = await openStore(new IDBFactory(), "acct-repress-lost");
    const e = engineOn(store, srv, { autoReplay: false });
    await e.start();
    srv.net.mode = "offline";
    const pressed = send("ada", "first");
    const a = await e.mutate(pressed);
    expect(a.status).toBe("queued");
    srv.net.mode = "ok";
    srv.plan.push("holdfail");
    const flush = e.flushPending();
    await until(() => srv.attempts.length === 2, "the send on the wire");
    const commit = store.commitLocal.bind(store);
    let refuse = true;
    store.commitLocal = (async (...args: Parameters<typeof commit>) => {
      if (refuse) { refuse = false; throw new Error("QuotaExceededError"); }
      return commit(...args);
    }) as typeof store.commitLocal;
    const again = await e.mutate(pressed, { key: a.key });
    expect([again.status, again.error?.code]).toEqual(["rolled_back", "storage_refused"]);
    srv.release();
    const results = await flush;
    expect(results.find((r) => r.key === a.key)?.status, "the older was dropped for a newer that was never written").toBe("queued");
    const later = await e.flushPending();
    expect(later.find((r) => r.key === a.key)?.status).toBe("confirmed");
    expect(srv.delivered.size, "the send was lost").toBe(1);
    expect(store.entries(OUTBOX_TYPE)).toHaveLength(0);
    store.close();
  }, 20_000);

  it("a replacement whose record THROWS takes its mark back too", async () => {
    const srv = server();
    const store = await openStore(new IDBFactory(), "acct-repress-throw");
    const e = engineOn(store, srv, { autoReplay: false });
    await e.start();
    srv.net.mode = "offline";
    // A send that names its row: its record is planned over the store's abandoned rows, a read that can throw.
    const pressed = { ...send("ada", "first"), draftId: "d-ada" } as EngineMutation;
    const a = await e.mutate(pressed);
    expect(a.status).toBe("queued");
    srv.net.mode = "ok";
    srv.plan.push("holdfail");
    const flush = e.flushPending();
    await until(() => srv.attempts.length === 2, "the send on the wire");
    // The road a refusal does not take: the record THROWS instead of answering `persisted: false`.
    const entries = store.entries.bind(store);
    let throws = true;
    store.entries = ((type: string) => {
      if (throws && type === OUTBOX_ABANDONED_TYPE) { throws = false; throw new Error("the record threw"); }
      return entries(type);
    }) as typeof store.entries;
    const again = await e.mutate(pressed, { key: a.key }).then(() => "answered", (err: unknown) => (err as Error).message);
    expect(again).toBe("the record threw");
    srv.release();
    const results = await flush;
    expect(results.find((r) => r.key === a.key)?.status, "the older was dropped for a newer that threw").toBe("queued");
    const later = await e.flushPending();
    expect(later.find((r) => r.key === a.key)?.status).toBe("confirmed");
    expect(srv.delivered.size, "the send was lost").toBe(1);
    store.close();
  }, 20_000);
});

describe("Cancel on a press waiting its turn at the gate", () => {
  it("is stopped at the wire: the read on the line before the wire is the only thing that can", async () => {
    const srv = server();
    const store = await openStore(new IDBFactory(), "acct-repress-cancel");
    const { e, a } = await twoQueued(srv, store);
    srv.plan.push("hold");
    const flush = e.flushPending();
    await until(() => srv.attempts.length === 3, "the head on the wire");
    const KEY = "fresh-press-key";
    const pressed = e.mutate(send("cy", "never mind"), { key: KEY });
    await tick();
    expect(e.pendingMutations().some((p) => p.key === KEY), "the fresh press is on the queue, so this measures the splice").toBe(false);
    expect(await e.withdrawQueued(KEY)).toBe("gone");
    srv.release();
    await flush;
    const res = await pressed;
    expect(res.status).toBe("rolled_back");
    expect(res.error?.code, "rolled back for some other reason than the withdrawal").toBe(OUTBOX_WITHDRAWN_CODE);
    expect(srv.sendsUnder(KEY), "a press withdrawn while it waited its turn reached the wire").toBe(0);
    expect(srv.delivered.has(a.key)).toBe(true);
    store.close();
  }, 20_000);
});

describe("Try again's row carries the whole intent (LOW-4)", () => {
  const PLAN: SendAndDonePlan = { section: "new", source: "m1", messageIds: ["m1"] };
  it("after a kill mid-retry, the row comes back with its created row and its Send + Done", async () => {
    const factory = new IDBFactory();
    const clock = { t: NOW };
    const srv = server();
    const s1 = await openStore(factory, "acct-repress-retry");
    const first = engineOn(s1, srv, { autoReplay: false, clock });
    await first.start();
    srv.net.mode = "fail500";
    await first.mutate(send("ada", "thanks, done"), { andDone: PLAN });
    for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES * 2 && first.abandoned().length === 0; i++) {
      clock.t += OUTBOX_BACKOFF_CAP_MS + 1;
      await first.flushPending();
    }
    const [row] = first.abandoned();
    expect(row?.mutation.kind, "the send was not given up on at the ceiling").toBe("mail_send");
    s1.close();

    srv.net.mode = "hang";
    const s2 = await openStore(factory, "acct-repress-retry");
    const second = engineOn(s2, srv, { autoReplay: false, deadlineMs: 60, clock });
    await second.start();
    expect((await second.retryAbandoned(row!.id)).status).toBe("queued");
    const live = s2.entries<{ createdRow?: unknown; andDone?: unknown; attempts?: number }>(OUTBOX_TYPE).map((x) => x.entity);
    s2.close();
    expect(live, "Try again wrote no live row").toHaveLength(1);
    expect(live[0]!.createdRow, "the live row lost the row the send made").toEqual({ id: "row-1", revision: null });
    expect(live[0]!.andDone, "the live row lost its Send + Done").toEqual(PLAN);
    expect(live[0]!.attempts).toBe(0);

    srv.net.mode = "ok";
    const s3 = await openStore(factory, "acct-repress-retry");
    const third = engineOn(s3, srv, { autoReplay: false, clock });
    await third.start();
    const res = await third.flushPending();
    expect(res[0]?.status).toBe("confirmed");
    expect(res[0]?.andDone, "the replay after the kill lost its release").toEqual(PLAN);
    expect(srv.rows.size, "the replay made a second row").toBe(1);
    s3.close();
  }, 20_000);
});
