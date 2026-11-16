import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { mailboxes, drafts } from "@trafficflow/db";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { DraftsService, SendService, dbFor } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

/**
 * THE MOVABLE SENDING MAILBOX UNDER REAL CONCURRENCY — the two interleavings PGlite cannot run.
 *
 * A draft's `mailboxId` is PATCHable while the row is a draft, and the send reads the row. Those
 * two writers meet on one row, and each order has a correctness claim that only holds under a
 * genuine cross-connection lock:
 *
 *  1. RESERVE BEHIND AN UNCOMMITTED MOVE. `SendService.reserve` reads the draft `FOR UPDATE`.
 *     Without the lock this is the wrong-From race in miniature: a plain read-committed SELECT
 *     does not wait for the move's row lock — it reads the PRE-move snapshot, the envelope is
 *     built from the old mailbox, and the move then commits, so the mail leaves as identity A
 *     while the row (and every screen) says B. The lock makes reserve wait and read what the
 *     move committed. This test was watched red against the plain SELECT — the fake adapter
 *     was opened for the OLD mailbox — before `.for("update")` was added.
 *
 *  2. A MOVE BEHIND A SEND THAT WINS. `DraftsService.update` puts `status = 'draft'` in the
 *     UPDATE's own predicate, not in a prior read, precisely so that a blocked move RE-EVALUATES
 *     it after the winner commits: the row it finally locks is `sending`, zero rows match, and
 *     the move answers 409 instead of rewriting the identity of a send already reserved under
 *     the old one. A read-then-write would have checked `draft` before blocking and written
 *     anyway.
 *
 * ## Why REAL Postgres (CLAUDE.md)
 * Both cases are about what happens ACROSS a held row lock — one connection blocking another,
 * then re-reading. PGlite is a single connection; nothing can hold a lock against anything.
 */
const PG_UP = await realPgAvailable();

// The factory's handle: the binder takes a server handle only from the factory that registered its
// door. `sqlB` is a second session's raw client.
const owned = makeOwnedDb(PG_TEST_URL);
const dbA = owned.db;
const sqlB = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });

const NOW = new Date("2026-08-12T12:00:00.000Z");
const draftsSvc = new DraftsService();
const sendSvc = new SendService();
const sleep = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms); });

/** A fake SendAdapter — NO network. Records which mailbox it was opened for, and what it sent. */
function fakeAdapter() {
  const state = { opened: [] as string[], delivered: [] as OutboundMessage[] };
  const factory: OpenSendAdapter = async (mailboxId: string) => {
    state.opened.push(mailboxId);
    return {
      async send(msg: OutboundMessage) {
        state.delivered.push(msg);
        return { providerMessageId: msg.messageId! };
      },
      async messageInSent() { return false; },
      async close() { /* nothing to tear down */ },
    };
  };
  return { factory, state };
}

async function seeded() {
  const accountId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const [mbA] = await dbA.insert(mailboxes).values({
    accountId, provider: "imap", address: `race-a-${tag}@old.test`,
  }).returning();
  const [mbB] = await dbA.insert(mailboxes).values({
    accountId, provider: "imap", address: `race-b-${tag}@new.test`,
  }).returning();
  const [d] = await dbA.insert(drafts).values({
    accountId, mailboxId: mbA!.id, subject: "which identity?", body: "text",
    to: [{ name: null, address: "you@example.com" }], status: "draft",
    createdAt: NOW, updatedAt: NOW,
  }).returning();
  const ctx: ServiceContext = { db: dbFor(dbA, accountId), accountId, userId: null, now: () => NOW, requestId: "r" };
  return { ctx, mbA: mbA!.id, mbB: mbB!.id, addressB: mbB!.address, draftId: d!.id };
}

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await owned.close(); await sqlB.end({ timeout: 5 }); });

describe.skipIf(!PG_UP)("the movable sending mailbox under a held row lock", () => {
  it("reserve blocked behind an uncommitted move sends from the mailbox the move committed", async () => {
    const w = await seeded();
    const fake = fakeAdapter();

    // Connection B moves the draft to mailbox B and HOLDS the transaction open.
    let releaseLock!: () => void;
    const held = new Promise<void>((r) => { releaseLock = r; });
    const moveTx = sqlB.begin(async (tx) => {
      await tx`update drafts set mailbox_id = ${w.mbB} where id = ${w.draftId}`;
      await held;
    });
    await sleep(150); // let the move take its row lock

    // Connection A sends. Reserve must WAIT for the move, not read around it.
    const sendP = sendSvc.send(w.ctx, w.draftId, randomUUID(), { openSendAdapter: fake.factory });
    await sleep(300);
    expect(fake.state.opened, "reserve read past the move's uncommitted lock").toHaveLength(0);

    releaseLock();
    await moveTx;
    const res = await sendP;

    expect(res.status).toBe("sent");
    // The dial, the envelope and the minted id are all the MOVED-TO identity's.
    expect(fake.state.opened, "the send dialed the pre-move mailbox").toEqual([w.mbB]);
    expect(fake.state.delivered).toHaveLength(1);
    expect(fake.state.delivered[0]!.from).toBe(w.addressB);
    expect(fake.state.delivered[0]!.messageId).toMatch(/@new\.test>$/);
  });

  it("a move blocked behind a send that reserved first re-evaluates and answers 409", async () => {
    const w = await seeded();

    // Connection B is "the send": it flips the row to `sending` and holds the lock —
    // exactly the state a reserve transaction leaves the row in mid-flight.
    let releaseLock!: () => void;
    const held = new Promise<void>((r) => { releaseLock = r; });
    const reserveTx = sqlB.begin(async (tx) => {
      await tx`update drafts set status = 'sending' where id = ${w.draftId}`;
      await held;
    });
    await sleep(150);

    // Connection A tries to move the mailbox. It must block, re-check, and refuse.
    const moveP = draftsSvc.update(w.ctx, w.draftId, { mailboxId: w.mbB })
      .then(() => null)
      .catch((e: unknown) => e as { httpStatus?: number });
    await sleep(300);

    releaseLock();
    await reserveTx;
    const err = await moveP;

    expect(err, "the move landed on a row a send had already reserved").not.toBeNull();
    expect(err!.httpStatus).toBe(409);
    const [row] = await dbA.select().from(drafts).where(eq(drafts.id, w.draftId));
    expect(row!.mailboxId, "the reserved send's identity was rewritten under it").toBe(w.mbA);
  });
});
