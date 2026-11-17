import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, asc, eq, sql } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { schema } from "@trafficflow/db/cloud";
import { accounts, changeLog, mailboxes, messageFailures, messageInvitations, messages, type Tx } from "@trafficflow/db";
import { pgTestUrl, realPgAvailable } from "@trafficflow/db/testing";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { runSyncCycle } from "../src/sync.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";
import { invitationLetter, ME, recorder, reply, request } from "./_invitations.js";

/**
 * THE INVITATION'S STATEMENTS ON A SERVER'S STORE. A fault of the store inside them (here a lock
 * wait cut short, as the runtime's `lock_timeout` cuts one) is the store's, not the letter's: the
 * letter's whole transaction fails, nothing is kept and nothing is written off, and the next cycle
 * stores the letter with its row. Kept without the row, the letter would never be read again.
 */
const URL = pgTestUrl(import.meta.url);
const PG_UP = await realPgAvailable(URL);
// The ingest's connections give up a lock wait as the worker's do, only sooner; the holder's wait.
const ingestSql = postgres(URL, { max: 3, onnotice: () => {}, connection: { lock_timeout: 300 } });
const holderSql = postgres(URL, { max: 1, onnotice: () => {} });
afterAll(async () => { await Promise.all([ingestSql.end({ timeout: 5 }), holderSql.end({ timeout: 5 })]); });

describe.skipIf(!PG_UP)("a fault of the store inside the invitation's statements, on real Postgres", () => {
  it("fails the letter's transaction; the next cycle stores the letter, its row and the answer it records", async () => {
    const db = brandDialect(drizzle(ingestSql, { schema }), "pg") as unknown as Tx;
    const holder = brandDialect(drizzle(holderSql, { schema }), "pg") as unknown as Tx;
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `invitation-${accountId.slice(0, 8)}` } as never);
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: ME }).returning();
    const fleet = new FakeAdapterFleet();
    const adapter = fleet.factory({ host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials here */ } });
    const log = recorder();
    const cycle = (): Promise<unknown> => runSyncCycle({
      log, writeAuthority: FIXTURE_LEASE, role: "organizer", trustedAuthservIds: new Set<string>(), signatures: null,
      repo: makeDrizzleRepo(db as never), adapter, accountId, mailboxId: mb!.id, storageCap: UNMETERED_STORAGE_CAP,
    });
    const uid = `kickoff-${accountId}@studio.example`;
    const ask = invitationLetter(`ask-${accountId}@studio.example`, request(uid, 0));
    const answer = invitationLetter(`answer-${accountId}@lichtgrat.example`, reply(uid, "DECLINED", "20261111T090000Z", 0), {
      from: ME, folder: "Sent", ownAuthored: true,
    });
    const rows = () => db.select({ mid: messages.messageIdHeader, row: messageInvitations }).from(messageInvitations)
      .innerJoin(messages, eq(messages.id, messageInvitations.messageId)).where(eq(messageInvitations.accountId, accountId));
    fleet.behave(mb!.id, { deliver: [ask] });
    await cycle();
    const [asked] = await rows();
    expect(asked?.row).toMatchObject({ method: "REQUEST", answer: null });

    // Another connection holds the invitation's row, as a press does in its draft's transaction.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const holding = new Promise<void>((r) => { locked = r; });
    const holderDone = holder.transaction(async (tx) => {
      await tx.execute(sql`select 1 from message_invitations where account_id = ${accountId} for update`);
      locked();
      await held;
    });
    await holding;
    fleet.behave(mb!.id, { deliver: [ask, answer] });
    const second = await cycle().then(() => null, (e: unknown) => e);
    release();
    await holderDone;

    expect(second, "the cycle went on past a fault of the store").toMatchObject({ code: "55P03" });
    const stored = await db.select({ mid: messages.messageIdHeader }).from(messages).where(eq(messages.accountId, accountId));
    expect(stored.map((s) => s.mid)).toEqual([ask.messageId]);
    expect(await db.select().from(messageFailures).where(eq(messageFailures.accountId, accountId))).toEqual([]);
    expect(log.lines.filter((l) => l.event === "invitation_row_refused")).toEqual([]);
    const before = (await db.select({ seq: changeLog.seq }).from(changeLog).where(eq(changeLog.accountId, accountId))
      .orderBy(asc(changeLog.seq))).map((c) => BigInt(String(c.seq))).at(-1)!;

    // The store answers again: the reply is stored with its row, and records its answer with a change.
    await cycle();
    const after = new Map((await rows()).map((r) => [r.mid, r.row]));
    expect(after.get(answer.messageId)).toMatchObject({ method: "REPLY", answer: "declined", invitedAddress: ME });
    expect(after.get(ask.messageId)).toMatchObject({ answer: "declined", answeredAt: new Date("2026-11-11T09:00:00Z") });
    const changed = await db.select({ seq: changeLog.seq, op: changeLog.op }).from(changeLog)
      .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityId, asked!.row.messageId)));
    expect(changed.filter((c) => BigInt(String(c.seq)) > before).map((c) => c.op)).toEqual(["update"]);
  }, 60_000);
});
