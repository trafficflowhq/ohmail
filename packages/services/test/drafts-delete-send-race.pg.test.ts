import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { mailboxes, drafts, outboundSends } from "@trafficflow/db";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { DraftsService, dbFor } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

/**
 * DELETING A DRAFT A SEND IS RESERVING — the two interleavings PGlite cannot run.
 *
 * `DraftsService.remove` used to answer 500 for a row with a send on record: the DELETE hit
 * `outbound_sends.draft_id`'s foreign key and the constraint violation reached the client as an
 * unhandled fault. It answers a named 409 now (`send_recorded`), and the sentence it carries says
 * the message stays in Drafts BECAUSE it has a send on record — which is the true reason and also
 * the only thing a person can act on.
 *
 * ## WHY THE READ IS `FOR UPDATE` AND NOT A PLAIN SELECT — the half PGlite cannot judge
 *
 * A check that merely READ `outbound_sends` would answer about the past. `SendService.reserve`
 * inserts its reservation in ANOTHER transaction, and that INSERT takes a `FOR KEY SHARE` on this
 * drafts row for the foreign key. So a reserve committing between the read and the DELETE loses
 * the draft: the read saw no reservation and the DELETE ran anyway. Since mail 0095 the key is
 * `ON DELETE SET NULL`, so that ending is no longer a 500 — it is a SILENT delete that leaves the
 * reservation naming no draft, which is worse.
 *
 * `FOR UPDATE` is the one row-lock mode that conflicts with `FOR KEY SHARE`. Taking it here
 * serializes the two, and the serialization is the whole claim:
 *
 *  1. RESERVE FIRST. The delete's locked read WAITS for the reserve, then sees the reservation and
 *     answers 409. It never reaches the DELETE, so the foreign key is never the messenger.
 *  2. DELETE FIRST. The reserve's own locked read finds no draft and answers 404.
 *
 * Neither ending is the constraint. Both are about one connection blocking another and then
 * RE-READING, which is exactly what PGlite — a single connection — cannot stage: nothing there can
 * hold a lock against anything, so the race window does not exist and the plain SELECT passes.
 * The API suite's PGlite cases prove the sentence and the status; this file proves the ordering.
 *
 * ## THE CONTROL THAT MAKES CASE 1 EVIDENCE, AND WHAT THE MUTATION ACTUALLY REDDENS
 *
 * `remove` HAS NOT ANSWERED while the reserving transaction is open: that proves the race was
 * staged, not the lock — the DELETE itself waits on the reservation's KEY SHARE. MEASURED
 * 2026-09-22 with `forUpdate` weakened to a plain read: that assertion stays green and the case
 * goes red on "a draft with a send on record was deleted"; the reservation's `draft_id` then reads
 * NULL, which the last assertion pins.
 */
const PG_UP = await realPgAvailable();

// The factory's handle: the binder takes a server handle only from the factory that registered its
// door. `sqlA` and `sqlB` are raw clients that hold the row from beside the service.
const owned = makeOwnedDb(PG_TEST_URL);
const dbA = owned.db;
const sqlA = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });
const sqlB = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });

const NOW = new Date("2026-09-08T12:00:00.000Z");
const draftsSvc = new DraftsService();
const sleep = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms); });

async function seeded(): Promise<{ ctx: ServiceContext; draftId: string; accountId: string }> {
  const accountId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const [mb] = await dbA.insert(mailboxes).values({
    accountId, provider: "imap", address: `del-race-${tag}@old.test`,
  }).returning();
  const [d] = await dbA.insert(drafts).values({
    accountId, mailboxId: mb!.id, subject: "already on its way?", body: "text",
    to: [{ name: null, address: "you@example.com" }], status: "draft",
    createdAt: NOW, updatedAt: NOW,
  }).returning();
  const ctx: ServiceContext = { db: dbFor(dbA, accountId), accountId, userId: null, now: () => NOW, requestId: "r" };
  return { ctx, draftId: d!.id, accountId };
}

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await owned.close(); await sqlA.end({ timeout: 5 }); await sqlB.end({ timeout: 5 }); });

describe.skipIf(!PG_UP)("deleting a draft a send is reserving, across a held row lock", () => {
  it("a delete behind an uncommitted reservation waits, then answers 409 — never the foreign key", async () => {
    const w = await seeded();

    /* Connection B is the reserve: it inserts the reservation — which takes FOR KEY SHARE on the
       drafts row for the foreign key — and HOLDS the transaction open. This is the exact state
       `SendService.reserve` leaves the row in between its INSERT and its commit. */
    let releaseLock!: () => void;
    const held = new Promise<void>((r) => { releaseLock = r; });
    const reserveTx = sqlB.begin(async (tx) => {
      await tx`
        insert into outbound_sends (account_id, idempotency_key, draft_id, minted_message_id)
        values (${w.accountId}, ${randomUUID()}, ${w.draftId}, ${`<${randomUUID()}@old.test>`})
      `;
      await held;
    });
    await sleep(150); // let the insert take its key-share on the draft row

    let answered = false;
    const removeP = draftsSvc.remove(w.ctx, w.draftId)
      .then(() => { answered = true; return null; })
      .catch((e: unknown) => {
        answered = true;
        return e as { httpStatus?: number; code?: string; message?: string };
      });
    await sleep(300);

    /* THE STAGING CONTROL: the reservation is still open, so nothing may have answered yet. */
    expect(
      answered,
      "the delete answered while the reservation was still uncommitted, so the race was never "
      + "staged and the answer below proves nothing about the lock",
    ).toBe(false);

    releaseLock();
    await reserveTx;
    const err = await removeP;

    expect(err, "a draft with a send on record was deleted").not.toBeNull();
    expect(err!.httpStatus, "the refusal is not the named 409").toBe(409);
    expect(err!.code, "the refusal does not name the reason a person can act on").toBe("send_recorded");
    const [row] = await dbA.select().from(drafts).where(eq(drafts.id, w.draftId));
    expect(row, "the row a send is on record for is gone — the account's only copy of it").toBeDefined();
    const sends = await dbA.select({ draftId: outboundSends.draftId }).from(outboundSends)
      .where(eq(outboundSends.accountId, w.accountId));
    expect(sends.map((r) => r.draftId), "the reservation lost the draft it was made for")
      .toEqual([w.draftId]);
  });

  it("a reservation behind a delete that won finds no draft — the FK is never the messenger", async () => {
    const w = await seeded();

    /* Connection B is the DELETE, holding the row it locked. Connection A then tries to reserve
       against it the way the send path does: a locked read of the draft first. It must block, and
       what it finds after the delete commits is NO ROW — a 404 for the send, not a constraint. */
    let releaseLock!: () => void;
    const held = new Promise<void>((r) => { releaseLock = r; });
    const deleteTx = sqlB.begin(async (tx) => {
      await tx`delete from drafts where id = ${w.draftId}`;
      await held;
    });
    await sleep(150);

    const seen: Array<{ id: string }> = [];
    const reserveP = sqlA.begin(async (tx) => {
      const rows = await tx<Array<{ id: string }>>`
        select id from drafts where id = ${w.draftId} for update
      `;
      for (const r of rows) seen.push(r);
    });
    await sleep(300);
    expect(seen, "the reserve read past the delete's uncommitted lock").toHaveLength(0);

    releaseLock();
    await deleteTx;
    await reserveP;

    expect(
      seen,
      "the reserve found a draft the delete had already removed — the reservation it would then "
      + "insert is the foreign-key violation this seam exists to avoid",
    ).toHaveLength(0);
    const rows = await dbA.select().from(outboundSends).where(eq(outboundSends.draftId, w.draftId));
    expect(rows, "a reservation was written against a deleted draft").toHaveLength(0);
  });
});
