import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect, carryDialect } from "@trafficflow/db/dialect";
import { and, asc, eq } from "drizzle-orm";
import { changeLog, mailboxes, messages, messageStates, type Tx } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { triageService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";
import { bubbleUpPass } from "../src/bubble-up-cron.js";
import { dbUrlFor, refuseDriftedSharedDb } from "../../../packages/organizer/test/_workerdb.js";

/**
 * "RESURFACE NOW" AGAINST THE WORKER'S BUBBLE-UP PASS, ON REAL POSTGRES.
 *
 * Two writers can now put a row into `resurfaced`: the worker's {@link bubbleUpPass}, when a
 * scheduled resurface comes due, and a person pressing "Now", which transitions straight there in
 * the request's own transaction. Everything below is about what happens when both of them have an
 * opinion about the same row.
 *
 * ── WHY THIS CANNOT BE A PGlite TEST ──────────────────────────────────────────────────────
 *
 * PGlite is single-connection, so the whole hazard is unrepresentable in it: there is no second
 * physical connection to hold a row lock, `bubbleUpPass`'s guarded UPDATE can never be made to
 * re-evaluate its predicate against a row somebody else committed underneath it, and
 * `allocateSeq`'s row lock — the mechanism three production defects turned on — is uncontended by
 * construction. A green there would be a green from a simulator of the thing under test.
 *
 * ── THE THREE CLAIMS ──────────────────────────────────────────────────────────────────────
 *
 *  1. **"Now" SPENDS THE SCHEDULE.** This is the one that fails loudly for the implementation
 *     this slice exists to reject — "now" as `bubbled_up` with a date in the past. That row is
 *     still scheduled, so the next pass flips it a second time and the user gets a resurface they
 *     already dealt with. Here the schedule is gone before the response is written.
 *  2. **THE PASS CANNOT FLIP A ROW THE PRESS ALREADY TOOK.** Forced rather than hoped for: the
 *     press's upsert blocks on the flip's uncommitted row lock, so the two writes are genuinely
 *     ordered by Postgres and not by luck.
 *  3. **UNDER REAL CONTENTION THE LEDGER STAYS EXACT.** One `change_log` row per write that
 *     actually happened, seqs unique and gap-free. A gap means `allocateSeq` handed out a number
 *     whose transaction rolled back, and a `/sync` cursor that lands in it stalls.
 */

const URL = dbUrlFor(import.meta.url);

const NOW = new Date("2026-08-07T12:00:00.000Z");
const PAST = new Date("2020-01-01T00:00:00.000Z");
const FUTURE = new Date("2026-08-14T09:00:00.000Z");
const AFTER_FUTURE = new Date("2026-08-14T09:00:01.000Z");

// TWO PHYSICAL CONNECTIONS, and that is the point of the file. One client-side pool would
// serialize the two writers before Postgres ever saw them.
const clientW = postgres(URL, { max: 5 });   // the worker's
const clientU = postgres(URL, { max: 5 });   // the person's
const dbW = brandDialect(drizzle(clientW, { schema }), "pg");
const dbU = brandDialect(drizzle(clientU, { schema }), "pg");

function ctx(accountId: string, now: Date = NOW): ServiceContext {
  return { db: dbU as unknown as ServiceContext["db"], accountId, userId: null, now: () => now, requestId: "resurface-now" };
}

/** A mailbox for `accountId` — messages need one, nothing here reads it. */
async function seedMailbox(accountId: string): Promise<string> {
  const [row] = await dbW.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test` }).returning();
  return row!.id;
}

/**
 * A message with a `bubbled_up` state at `at`. Inserted DIRECTLY, with no `change_log` row: the
 * ledger assertions below count writes made by the two writers under test, so the fixture must
 * not contribute to it.
 */
async function seedScheduled(accountId: string, mailboxId: string, at: Date): Promise<{ messageId: string; stateId: string }> {
  const dedup = `mid:${randomUUID()}`;
  const [m] = await dbW.insert(messages).values({
    accountId, mailboxId, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
    subject: "scheduled", fromAddress: "a@ex.example", nativeLocator: { folder: "INBOX", ref: "1:1" },
  }).returning();
  const [st] = await dbW.insert(messageStates).values({
    accountId, messageId: m!.id, state: "bubbled_up", bubbleUpAt: at,
  }).returning();
  return { messageId: m!.id, stateId: st!.id };
}

const stateRow = async (stateId: string): Promise<{ state: string; bubbleUpAt: Date | null }> => {
  const [row] = await dbW.select().from(messageStates).where(eq(messageStates.id, stateId));
  return { state: row!.state, bubbleUpAt: row!.bubbleUpAt };
};

const ledger = async (accountId: string): Promise<Array<{ entityType: string; op: string; seq: bigint }>> => {
  const rows = await dbW.select().from(changeLog)
    .where(eq(changeLog.accountId, accountId)).orderBy(asc(changeLog.seq));
  return rows.map((r) => ({ entityType: r.entityType, op: r.op, seq: r.seq }));
};

/** Seqs are unique and consecutive within the account — the property a `/sync` cursor rests on. */
function expectGapFree(seqs: bigint[]): void {
  expect(new Set(seqs.map(String)).size).toBe(seqs.length);
  for (let i = 1; i < seqs.length; i++) expect(seqs[i]! - seqs[i - 1]!).toBe(1n);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("resurface now ⇄ the bubble-up pass (real Postgres)", () => {
  // BEFORE the migrator, not after: `runMigrations` on a database whose journal is ahead of this
  // tree's RECORDS this tree's migrations as applied without running them, and raises nothing.
  // `refuseDriftedSharedDb` is the same door the harness in `_workerenv.ts` uses; this file is the
  // one that reaches the shared database without going through it, which is why it says so here.
  beforeAll(async () => { await refuseDriftedSharedDb(URL); await runMigrations(URL); }, 60000);
  afterAll(async () => {
    await clientW.end({ timeout: 5 });
    await clientU.end({ timeout: 5 });
  });

  it("'Now' on a SCHEDULED row spends the schedule — a later pass flips nothing", async () => {
    const accountId = randomUUID();
    const mailboxId = await seedMailbox(accountId);
    const { messageId, stateId } = await seedScheduled(accountId, mailboxId, FUTURE);

    const dto = await triageService.resurfaceNow(ctx(accountId), messageId);
    expect(dto).toMatchObject({ messageId, state: "resurfaced", bubbleUpAt: null });
    expect(await stateRow(stateId)).toEqual({ state: "resurfaced", bubbleUpAt: null });

    // THE ASSERTION THIS FILE EXISTS FOR. Spelled as `bubbled_up` with a past date, the row would
    // still be scheduled here and this pass would flip it — a second resurface of mail the reader
    // already saw, arriving whenever the worker next ran.
    expect(await bubbleUpPass(dbW as unknown as Tx, AFTER_FUTURE, { accountId, mailboxIds: [mailboxId] })).toEqual({ flipped: 0 });
    expect(await stateRow(stateId)).toEqual({ state: "resurfaced", bubbleUpAt: null });

    // ONE press, TWO changes: the `message_state` row, and the `message` whose DTO embeds it —
    // without the second, no client but the one that pressed can pin the row.
    const rows = await ledger(accountId);
    expect(rows.map((r) => `${r.entityType}:${r.op}`)).toEqual(["message_state:update", "message:update"]);
    expectGapFree(rows.map((r) => r.seq));
  }, 60000);

  it("a press that lands on an IN-FLIGHT flip blocks on its row lock, then converges", async () => {
    const accountId = randomUUID();
    const mailboxId = await seedMailbox(accountId);
    const { messageId, stateId } = await seedScheduled(accountId, mailboxId, PAST);

    let pressed = false;
    let press!: Promise<unknown>;

    // The pass runs INSIDE an outer transaction on the worker's connection, so its flip is
    // committed to nothing and its row locks are still held when the press arrives. (drizzle
    // nests via SAVEPOINT, so `bubbleUpPass`'s own `transaction()` joins this one.)
    await dbW.transaction(async (tx) => {
      // The pass composes a row lock through the dialect seam, and a transaction object carries
      // no brand of its own — carried from the handle this transaction was opened on.
      const res = await bubbleUpPass(carryDialect(dbW, tx as object) as unknown as Tx, NOW, { accountId, mailboxIds: [mailboxId] });
      expect(res).toEqual({ flipped: 1 });

      press = triageService.resurfaceNow(ctx(accountId), messageId).then((r) => { pressed = true; return r; });
      await sleep(400);
      // BLOCKED, and this is the assertion that makes the rest of the test mean anything: without
      // it the two writes could have been ordered by nothing more than scheduling luck.
      expect(pressed, "the press did not block on the flip's uncommitted row lock").toBe(false);
    });

    await expect(press).resolves.toMatchObject({ messageId, state: "resurfaced", bubbleUpAt: null });
    expect(await stateRow(stateId)).toEqual({ state: "resurfaced", bubbleUpAt: null });

    /* The flip's pair, then the press's pair. The press does not undo the flip and the flip is not
       re-emitted: two writes, four rows.
       The flip used to contribute ONE row here — its `message_state` update alone — and that was
       the defect, not the baseline: the pass had the same hole in it that `setState` had, so a
       resurface nobody pressed pinned on no live client. It now emits the projection beside the
       state, exactly as the press does, and the two writers are indistinguishable on the wire. */
    const rows = await ledger(accountId);
    expect(rows.map((r) => `${r.entityType}:${r.op}`)).toEqual([
      "message_state:update", "message:update",
      "message_state:update", "message:update",
    ]);
    expectGapFree(rows.map((r) => r.seq));
  }, 60000);

  it("a pass and twelve presses racing on separate connections: every row resurfaced, ledger exact", async () => {
    const accountId = randomUUID();
    const mailboxId = await seedMailbox(accountId);
    const seeded = [];
    for (let i = 0; i < 12; i++) seeded.push(await seedScheduled(accountId, mailboxId, PAST));

    // The worker's due-scan and the person's twelve presses, genuinely interleaved inside
    // Postgres. Which writer wins any given row is not decided here and must not need to be.
    const [pass] = await Promise.all([
      bubbleUpPass(dbW as unknown as Tx, NOW, { accountId, mailboxIds: [mailboxId] }),
      Promise.all(seeded.map((s) => triageService.resurfaceNow(ctx(accountId), s.messageId))),
    ]);

    for (const s of seeded) {
      expect(await stateRow(s.stateId)).toEqual({ state: "resurfaced", bubbleUpAt: null });
    }
    // Nothing is left in a flippable state, whoever got there first.
    expect(await bubbleUpPass(dbW as unknown as Tx, NOW, { accountId, mailboxIds: [mailboxId] })).toEqual({ flipped: 0 });

    /* ONE PAIR per write that actually happened. Twelve presses is twelve pairs; the pass adds one
       PAIR per row it won — not one `message_state` update, which is what this counted while the
       pass was still emitting the state without its projection. A count above this would mean a
       write was emitted twice; a `msgs` count below `states` would mean a resurface that no live
       client could see, which is the whole subject of both halves of this slice. */
    const rows = await ledger(accountId);
    const states = rows.filter((r) => r.entityType === "message_state");
    const msgs = rows.filter((r) => r.entityType === "message");
    expect(states).toHaveLength(12 + pass.flipped);
    expect(msgs).toHaveLength(12 + pass.flipped);
    expect(rows).toHaveLength(2 * (12 + pass.flipped));
    expect(pass.flipped).toBeLessThanOrEqual(12);
    expectGapFree(rows.map((r) => r.seq));
  }, 60000);
});
