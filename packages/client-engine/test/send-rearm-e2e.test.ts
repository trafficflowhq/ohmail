import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { eq } from "drizzle-orm";
import { messages, outboundSends } from "@trafficflow/db";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import {
  HttpAdapter, IndexedDbMirrorStore, MemoryMirrorStore, OhmailEngine, OUTBOX_TYPE,
  type EngineMessage, type FetchLike, type MirrorStore,
} from "@ohmail/client-engine";
import { FIXED_NOW, makeDeps, seedBody, seedMessage, seedSession } from "../../api/test/helpers.js";

/**
 * A SEND THAT WENT ON THE THIRD PRESS, END TO END, NOW GOES ON THE FIRST. The engine, its HTTP
 * adapter and the real send route over one database; the person's mail server hangs up on the
 * first dial. Before: the first answer was a 500, the engine's same-key retry met 409 `failed`,
 * and the send rolled back as `send_failed` for the person to press again under a new key. Now
 * the first answer is retryable with the server's wait, the engine waits it out and replays the
 * same key, and the server re-arms the one reservation: one row, one delivery. Cancel during the
 * wait withdraws the key on the server; a client that dies during the wait replays from its
 * durable outbox and the message still goes once.
 */

const app = createApp(apiRoutes);
const closed = (): Error => Object.assign(new Error("Connection closed"), { code: "EIMAPCLOSED" });

async function world(store: () => MirrorStore = () => new MemoryMirrorStore()) {
  const delivered: OutboundMessage[] = [];
  let opens = 0;
  const factory: OpenSendAdapter = async () => {
    opens += 1;
    if (opens === 1) throw closed();
    return {
      async send(msg: OutboundMessage) { delivered.push(msg); return { providerMessageId: msg.messageId ?? "<none>" }; },
      async messageInSent() { return false; },
      async close() { /* nothing */ },
    };
  };
  const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
  const s = await seedSession(db, { now: FIXED_NOW });
  const m = await seedMessage(db, { accountId: s.accountId, folder: "INBOX", subject: "Hello", fromAddress: "lena@atelier.example" });
  await db.update(messages).set({ messageIdHeader: "<parent@atelier.example>" });
  await seedBody(db, { messageId: m.id, text: "Body." });
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    headers.set("authorization", `Bearer ${s.token}`);
    return app.handle(new Request(url, { ...init, headers }), { ...(deps as ApiDeps), session: null, idempotency: null });
  };
  let t = Date.parse("2026-10-19T08:00:00.000Z");
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const engineOver = async (st: MirrorStore) => {
    const engine = new OhmailEngine({
      adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl }), store: st, now: clock.now,
    });
    return engine;
  };
  const parent: EngineMessage = {
    id: m.id, accountId: s.accountId, mailboxId: m.mailboxId, threadId: null, messageIdHeader: "<parent@atelier.example>",
    subject: "Hello", from: { name: "Lena", address: "lena@atelier.example" }, to: [], cc: [],
    date: FIXED_NOW.toISOString(), folder: "INBOX", snippet: "…", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: FIXED_NOW.toISOString(),
  };
  const st = store();
  await st.applyChanges([{ type: "message", op: "create", id: parent.id, seq: 1, updatedAt: parent.updatedAt, entity: parent }]);
  const engine = await engineOver(st);
  const rows = () => db.select().from(outboundSends);
  return { db, engine, engineOver, parent, delivered, clock, rows, store: st };
}

describe("a send whose first dial meets a passing fault goes on the first press", () => {
  it("the engine waits out the server's wait and replays the same key: one row, one delivery", async () => {
    const w = await world();
    const first = await w.engine.mutate({ kind: "mail_send", inReplyTo: w.parent.id, body: "Gerne" });
    expect({ status: first.status, code: first.error?.code, retryable: first.error?.retryable, wait: first.error?.retryAfterMs })
      .toEqual({ status: "queued", code: "send_unreachable", retryable: true, wait: 2_000 });
    expect((await w.rows()).map((r) => r.status)).toEqual(["failed"]);

    // Inside the server's wait the flush asks nothing.
    const early = await w.engine.flushPending();
    expect(early.map((r) => r.status)).toEqual(["queued"]);
    expect(w.delivered).toHaveLength(0);

    w.clock.advance(2_500);
    const settled = await w.engine.flushPending();
    expect(settled.map((r) => ({ status: r.status, sameKey: r.key === first.key, code: r.error?.code ?? null })))
      .toEqual([{ status: "confirmed", sameKey: true, code: null }]);
    expect(w.delivered).toHaveLength(1);
    const rows = await w.rows();
    expect(rows.map((r) => ({ status: r.status, attempts: r.attempts }))).toEqual([{ status: "sent", attempts: 2 }]);
  });

  it("Cancel during the wait withdraws the key on the server, and nothing is ever delivered", async () => {
    const w = await world();
    const first = await w.engine.mutate({ kind: "mail_send", inReplyTo: w.parent.id, body: "Gerne" });
    expect(first.status).toBe("queued");
    expect(await w.engine.withdrawQueued(first.key)).toBe("withdrawn");
    const [row] = await w.rows();
    expect({ status: row!.status, retryUntil: row!.retryUntil }).toEqual({ status: "withdrawn", retryUntil: null });
    w.clock.advance(10_000);
    await w.engine.flushPending();
    expect(w.delivered).toHaveLength(0);
  });

  it("a client that dies during the wait replays from its durable outbox: still one delivery", async () => {
    const factory = new IDBFactory();
    const owner = "acct-rearm-durable";
    const w = await world(() => new IndexedDbMirrorStore({ owner, factory }));
    const first = await w.engine.mutate({ kind: "mail_send", inReplyTo: w.parent.id, body: "Gerne" });
    expect(first.status).toBe("queued");
    const onDisk = (w.store as IndexedDbMirrorStore).entries(OUTBOX_TYPE);
    expect(onDisk, "the waiting send is not on disk, so the restart measures nothing").toHaveLength(1);
    (w.store as IndexedDbMirrorStore).close();

    // The next launch, past the wait, on the same disk.
    w.clock.advance(3_000);
    const store2 = new IndexedDbMirrorStore({ owner, factory });
    const engine2 = await w.engineOver(store2);
    await engine2.hydrate();
    const replayed = await engine2.flushPending();
    expect(replayed.map((r) => ({ status: r.status, sameKey: r.key === first.key }))).toEqual([{ status: "confirmed", sameKey: true }]);
    expect(w.delivered).toHaveLength(1);
    expect((await w.rows()).map((r) => r.status)).toEqual(["sent"]);
    expect(store2.entries(OUTBOX_TYPE)).toHaveLength(0);
    store2.close();
    expect(await w.db.select().from(outboundSends).where(eq(outboundSends.idempotencyKey, first.key))).toHaveLength(1);
  });
});
