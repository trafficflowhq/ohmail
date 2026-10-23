import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { drafts, mailboxes, outboundSendFingerprints, outboundSends } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { SendService, ServiceError, TransientDialRefusal } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

/**
 * CANCEL ASKS THE SERVER — `SendService.withdraw` on real
 * Postgres. A key nobody reserved is tombstoned and every replay of it is refused with nothing
 * sent; a reserved key answers what its row says; a stale one is settled by verify-by-Sent and
 * never by SMTP. The race (e) is two connections, because PGlite is one and cannot block an
 * `ON CONFLICT` against an uncommitted row, which is the whole arbitration.
 */
const PG_UP = await realPgAvailable();

const sqlA = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });
const sqlB = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });
const dbA = brandDialect(drizzle(sqlA, { schema }), "pg");
const dbB = brandDialect(drizzle(sqlB, { schema }), "pg");

const NOW = new Date("2026-10-05T12:00:00.000Z");
const MIN = 60 * 1000;
const sleep = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms); });

async function seeded(body = "words") {
  const accountId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const [mb] = await dbA.insert(mailboxes).values({
    accountId, provider: "imap", address: `withdraw-${tag}@race.test`,
  }).returning();
  const [d] = await dbA.insert(drafts).values({
    accountId, mailboxId: mb!.id, subject: "the cancelled send", body,
    to: [{ name: null, address: "you@example.com" }], status: "draft",
    createdAt: NOW, updatedAt: NOW,
  }).returning();
  const ctxA: ServiceContext = { db: dbA, accountId, userId: null, now: () => NOW, requestId: "a" };
  const ctxB: ServiceContext = { db: dbB, accountId, userId: null, now: () => NOW, requestId: "b" };
  return { ctxA, ctxB, accountId, mailboxId: mb!.id, draftId: d!.id };
}

/** An SMTP spy: every `send` it takes is a delivery to a real person. */
function smtp(opts: { inSent?: boolean; hold?: Promise<void> } = {}) {
  const delivered: OutboundMessage[] = [];
  let opened = 0;
  const open: OpenSendAdapter = async () => {
    opened += 1;
    return {
      async send(msg: OutboundMessage) {
        delivered.push(msg);
        if (opts.hold) await opts.hold;
        return { providerMessageId: msg.messageId! };
      },
      async messageInSent() { return opts.inSent === true; },
      async close() { /* nothing to tear down */ },
    };
  };
  return { open, delivered, opened: () => opened };
}

async function rowOf(accountId: string, key: string) {
  const [row] = await dbA.select().from(outboundSends)
    .where(and(eq(outboundSends.accountId, accountId), eq(outboundSends.idempotencyKey, key)));
  return row ?? null;
}
async function refusal(p: Promise<unknown>): Promise<string> {
  try { await p; return "answered"; } catch (err) { return err instanceof ServiceError ? `${err.httpStatus} ${err.code}` : `threw ${String(err)}`; }
}

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await sqlA.end({ timeout: 5 }); await sqlB.end({ timeout: 5 }); });

describe.skipIf(!PG_UP)("a Cancel decided by the server", () => {
  it("(a) no row: a tombstone; the key's send is refused with nothing sent; the same words under a new key go once", async () => {
    const w = await seeded();
    const spy = smtp();
    // The engine log's line per answer, read through the injected logger.
    const lines: Array<{ event: string; outcome?: unknown }> = [];
    const log = {
      level: "info", child: () => log, debug: () => {}, warn: () => {}, error: () => {},
      info: (event: string, fields?: Record<string, unknown>) => { lines.push({ event, outcome: fields?.outcome }); },
    } as never;
    const said = await new SendService().withdraw(w.ctxB, "key-a", w.draftId, { openSendAdapter: spy.open, log });
    expect(lines.filter((l) => l.event === "send_withdraw")).toEqual([{ event: "send_withdraw", outcome: "withdrawn" }]);
    const replay = await refusal(new SendService().send(w.ctxA, w.draftId, "key-a", { openSendAdapter: spy.open }));
    const tomb = await rowOf(w.accountId, "key-a");
    const claims = await dbA.select().from(outboundSendFingerprints).where(eq(outboundSendFingerprints.accountId, w.accountId));
    const [d] = await dbA.select().from(drafts).where(eq(drafts.id, w.draftId));
    expect({ said: said.outcome, replay, smtp: spy.delivered.length, dialled: spy.opened(), claims: claims.length, draft: d!.status })
      .toEqual({ said: "withdrawn", replay: "409 send_withdrawn", smtp: 0, dialled: 0, claims: 0, draft: "draft" });
    expect({ status: tomb!.status, draftId: tomb!.draftId, resolvedBy: tomb!.resolvedBy })
      .toEqual({ status: "withdrawn", draftId: w.draftId, resolvedBy: "person" });
    const fresh = await new SendService().send(w.ctxA, w.draftId, "key-a2", { openSendAdapter: spy.open });
    expect({ status: fresh.status, smtp: spy.delivered.length }).toEqual({ status: "sent", smtp: 1 });
    // A repeat converges: the tombstone answers again and nothing else moves.
    expect((await new SendService().withdraw(w.ctxB, "key-a", w.draftId, { openSendAdapter: spy.open })).outcome).toBe("withdrawn");
  });

  it("(b) a sent row: already_sent, the delivery's own instant, nothing dialled", async () => {
    const w = await seeded();
    const spy = smtp();
    await new SendService().send(w.ctxA, w.draftId, "key-b", { openSendAdapter: spy.open });
    const sentAt = new Date("2026-10-05T11:58:00.000Z");
    await dbA.update(outboundSends).set({ sentAt }).where(eq(outboundSends.idempotencyKey, "key-b"));
    const before = spy.opened();
    const said = await new SendService().withdraw(w.ctxB, "key-b", w.draftId, { openSendAdapter: spy.open });
    expect({ outcome: said.outcome, at: said.firstSend?.at, smtp: spy.delivered.length, dialled: spy.opened() - before })
      .toEqual({ outcome: "already_sent", at: sentAt.toISOString(), smtp: 1, dialled: 0 });
  });

  it("(c) a young pending row: in_flight, nothing dialled, nothing written", async () => {
    const w = await seeded();
    await dbA.insert(outboundSends).values({
      accountId: w.accountId, idempotencyKey: "key-c", draftId: w.draftId, mintedMessageId: "<c@race.test>",
      status: "pending", createdAt: new Date(NOW.getTime() - 2 * MIN),
    });
    const spy = smtp();
    const said = await new SendService().withdraw(w.ctxB, "key-c", w.draftId, { openSendAdapter: spy.open });
    expect({ outcome: said.outcome, dialled: spy.opened(), status: (await rowOf(w.accountId, "key-c"))!.status })
      .toEqual({ outcome: "in_flight", dialled: 0, status: "pending" });
  });

  it("(d) a stale pending row is settled by verify-by-Sent, both ways, and a deferred dial claims nothing", async () => {
    const stale = async (key: string) => {
      const w = await seeded();
      await dbA.update(drafts).set({ status: "sending" }).where(eq(drafts.id, w.draftId));
      await dbA.insert(outboundSends).values({
        accountId: w.accountId, idempotencyKey: key, draftId: w.draftId, mintedMessageId: `<${key}@race.test>`,
        status: "pending", createdAt: new Date(NOW.getTime() - 11 * MIN),
      });
      return w;
    };
    const found = await stale("key-d1");
    const inSent = smtp({ inSent: true });
    const a = await new SendService().withdraw(found.ctxB, "key-d1", found.draftId, { openSendAdapter: inSent.open });
    const missing = await stale("key-d2");
    const notInSent = smtp({ inSent: false });
    const b = await new SendService().withdraw(missing.ctxB, "key-d2", missing.draftId, { openSendAdapter: notInSent.open });
    const busy = await stale("key-d3");
    const deferred: OpenSendAdapter = async (mailboxId) => { throw new TransientDialRefusal(mailboxId, "the organizer holds the mailbox"); };
    const c = await new SendService().withdraw(busy.ctxB, "key-d3", busy.draftId, { openSendAdapter: deferred });
    expect({
      found: [a.outcome, (await rowOf(found.accountId, "key-d1"))!.status],
      missing: [b.outcome, (await rowOf(missing.accountId, "key-d2"))!.status],
      deferred: [c.outcome, (await rowOf(busy.accountId, "key-d3"))!.status],
      smtp: inSent.delivered.length + notInSent.delivered.length,
    }).toEqual({
      found: ["already_sent", "sent"], missing: ["unverified", "unverified"], deferred: ["in_flight", "pending"], smtp: 0,
    });
  });

  it("(d2) a stale row that offered nothing: forgotten, then tombstoned; withdrawn, and a replay is refused", async () => {
    const w = await seeded();
    await dbA.update(drafts).set({ status: "sending" }).where(eq(drafts.id, w.draftId));
    const [row] = await dbA.insert(outboundSends).values({
      accountId: w.accountId, idempotencyKey: "key-d4", draftId: w.draftId, mintedMessageId: "<key-d4@race.test>",
      status: "pending", offerState: "unoffered", createdAt: new Date(NOW.getTime() - 11 * MIN),
    }).returning();
    // An inline press's reservation holds its content claim; only such a row is forgotten.
    await dbA.insert(outboundSendFingerprints).values({
      accountId: w.accountId, mailboxId: w.mailboxId, fingerprint: randomUUID().replace(/-/g, "").repeat(2), sendId: row!.id,
    });
    const spy = smtp({ inSent: false });
    const said = await new SendService().withdraw(w.ctxB, "key-d4", w.draftId, { openSendAdapter: spy.open });
    const replay = await refusal(new SendService().send(w.ctxA, w.draftId, "key-d4", { openSendAdapter: spy.open }));
    const [d] = await dbA.select().from(drafts).where(eq(drafts.id, w.draftId));
    expect({ said: said.outcome, row: (await rowOf(w.accountId, "key-d4"))!.status, replay, draft: d!.status, dialled: spy.opened(), smtp: spy.delivered.length })
      .toEqual({ said: "withdrawn", row: "withdrawn", replay: "409 send_withdrawn", draft: "draft", dialled: 0, smtp: 0 });
  });

  it("(e) a reservation committed first: the withdraw answers in_flight, the send lands once, the row is sent", async () => {
    const w = await seeded();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const spy = smtp({ hold: held });
    const sending = new SendService().send(w.ctxA, w.draftId, "key-e1", { openSendAdapter: spy.open, attemptCeilingMs: 10_000 });
    for (let i = 0; i < 200 && spy.delivered.length === 0; i++) await sleep(5);
    const said = await new SendService().withdraw(w.ctxB, "key-e1", w.draftId, { openSendAdapter: spy.open });
    release();
    const sent = await sending;
    expect({ said: said.outcome, sent: sent.status, smtp: spy.delivered.length, row: (await rowOf(w.accountId, "key-e1"))!.status })
      .toEqual({ said: "in_flight", sent: "sent", smtp: 1, row: "sent" });
  });

  it("(e) the tombstone committed first: the send is refused 409 and nothing leaves", async () => {
    const w = await seeded();
    const spy = smtp();
    const said = await new SendService().withdraw(w.ctxB, "key-e2", w.draftId, { openSendAdapter: spy.open });
    const sent = await refusal(new SendService().send(w.ctxA, w.draftId, "key-e2", { openSendAdapter: spy.open }));
    expect({ said: said.outcome, sent, smtp: spy.delivered.length, row: (await rowOf(w.accountId, "key-e2"))!.status })
      .toEqual({ said: "withdrawn", sent: "409 send_withdrawn", smtp: 0, row: "withdrawn" });
  });

  it("(e) both at once on two connections, twelve times: never a withdrawn row or answer beside a delivery", async () => {
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      const w = await seeded(`words ${i}`);
      const spy = smtp();
      const key = `key-e3-${i}`;
      const [send, cancel] = await Promise.allSettled([
        new SendService().send(w.ctxA, w.draftId, key, { openSendAdapter: spy.open }),
        new SendService().withdraw(w.ctxB, key, w.draftId, { openSendAdapter: spy.open }),
      ]);
      const row = (await rowOf(w.accountId, key))!.status;
      const said = cancel.status === "fulfilled" ? cancel.value.outcome : `threw ${String(cancel.reason)}`;
      const sendSaid = send.status === "fulfilled" ? send.value.status
        : send.reason instanceof ServiceError ? send.reason.code : `threw ${String(send.reason)}`;
      seen.push(`${said}/${sendSaid}/${row}/${spy.delivered.length}`);
    }
    const allowed = new Set(["withdrawn/send_withdrawn/withdrawn/0", "in_flight/sent/sent/1", "already_sent/sent/sent/1"]);
    expect(seen.filter((s) => !allowed.has(s)), `outcomes: ${seen.join(", ")}`).toEqual([]);
  }, 60_000);

  it("(f) another account's draft and key: a fresh tombstone here, draft unnamed, theirs untouched", async () => {
    const theirs = await seeded();
    const spy = smtp();
    await new SendService().send(theirs.ctxA, theirs.draftId, "key-f", { openSendAdapter: spy.open });
    const mine = await seeded();
    const said = await new SendService().withdraw(mine.ctxB, "key-f", theirs.draftId, { openSendAdapter: spy.open });
    const myTomb = await rowOf(mine.accountId, "key-f");
    const theirRow = await rowOf(theirs.accountId, "key-f");
    const [theirDraft] = await dbA.select().from(drafts).where(eq(drafts.id, theirs.draftId));
    expect({ said: said.outcome, myTomb: [myTomb!.status, myTomb!.draftId], theirRow: theirRow!.status, theirDraft: theirDraft!.status, smtp: spy.delivered.length })
      .toEqual({ said: "withdrawn", myTomb: ["withdrawn", null], theirRow: "sent", theirDraft: "sent", smtp: 1 });
  });
});
