import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { asc, eq } from "drizzle-orm";
import { accounts, approvals, changeLog, folderState, mailboxes, messages } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { ApprovalService, type ServiceContext } from "@trafficflow/services";

/**
 * ══ TWO DECISIONS ON ONE APPROVAL ═════════════════════════════════════════════════════════
 *
 * `ApprovalService.decide` reads the row and refuses a non-`pending` one, OUTSIDE the
 * transaction that then flips it. The flip used to carry a primary-key-only predicate:
 *
 *     await tx.update(approvals).set({ status: … }).where(eq(approvals.id, id))
 *
 * The check and the write were in different transactions, and the write asserted nothing about
 * the state the check had observed. That is check-then-act, not a claim — and it is NOT saved
 * by EvalPlanQual: the qual is the primary key, which no concurrent writer can falsify, so the
 * re-check under a lock wait always passes and BOTH writers land.
 *
 * Measured at HEAD before the fix, by the first case below: `approvalStatus: "approved"` with
 * `changes: ["approval/update", "approval/update", "message/move"]` — two resolutions of one
 * card in the delta stream. The second case measured the worse half: `rejected/INBOX`, an
 * approval that reads "turned away" over mail already re-routed to the Ohbox and queued for a
 * real IMAP move, because the reject branch writes no `folder_state` and so has nothing to undo.
 *
 * The fix is the shape the repo already uses everywhere it matters — `consumeLoginToken`,
 * `claimMessageFailures`, `bubbleUpPass`, the credits debit: repeat the state predicate in the
 * UPDATE's own WHERE and treat the returned row count as the decision.
 *
 * The interleave below is DETERMINISTIC, not a `Promise.all` that hopes for a schedule: the
 * second decision is driven to completion inside the window between the first one's read and
 * its write, by wrapping `db.transaction` — the same seam `screener-destination.pg.test.ts`
 * uses. Both connections are real and pooled.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId,
  userId: null,
  now: () => new Date(),
  requestId: `appr-${randomUUID().slice(0, 8)}`,
});

interface World { accountId: string; approvalId: string; messageId: string }

/** One pending routing approval over one message sitting in the Screener. */
async function newWorld(): Promise<World> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `appr-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `appr-${accountId.slice(0, 8)}@example.test`,
  }).returning();

  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: `appr`, dedupKey: `appr:${randomUUID()}`,
    subject: "Needs a decision", fromAddress: "stranger@nobody.test",
    nativeLocator: { folder: "ohmail/Screener", ref: "1:1" },
  }).returning();
  await db.insert(folderState).values({
    messageId: m!.id, accountId: m!.accountId, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });

  const [a] = await db.insert(approvals).values({
    accountId, kind: "routing", messageId: m!.id, action: "move",
    summary: "File this to the Ohbox", payload: { folder: "INBOX" }, status: "pending",
  }).returning();

  return { accountId, approvalId: a!.id, messageId: m!.id };
}

const changesOf = async (accountId: string) =>
  db.select({ entity: changeLog.entityType, op: changeLog.op, id: changeLog.entityId })
    .from(changeLog).where(eq(changeLog.accountId, accountId)).orderBy(asc(changeLog.seq));

describe.skipIf(!PG_UP)("two concurrent decisions on one approval", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("a second decision landing between the first one's read and its write is refused", async () => {
    const w = await newWorld();
    const svc = new ApprovalService({});

    // The FIRST decision — an approve. Its `pending` read has already happened when the rival
    // runs, exactly as it has in production the moment two devices answer the same card.
    const first = ctx(w.accountId);
    const realTransaction = db.transaction.bind(db);
    let rivalOutcome: "approved" | "rejected" | "refused" | "never ran" = "never ran";
    (first.db as unknown as { transaction: typeof realTransaction }).transaction = (async (
      cb: Parameters<typeof realTransaction>[0],
    ) => {
      if (rivalOutcome === "never ran") {
        rivalOutcome = "refused";
        try {
          // A REJECT from the other device, committed in the window. Note it is the OPPOSITE
          // decision: if both land, the folder and the row disagree about what the user chose.
          await svc.decide(ctx(w.accountId), w.approvalId, { decision: "reject" });
          rivalOutcome = "rejected";
        } catch { rivalOutcome = "refused"; }
      }
      return realTransaction(cb);
    }) as typeof realTransaction;

    let firstRefused = false;
    try {
      await svc.decide(first, w.approvalId, { decision: "approve" });
    } catch { firstRefused = true; }

    expect(rivalOutcome, "the rival decision never ran — this test proved nothing").not.toBe("never ran");

    const [row] = await db.select().from(approvals).where(eq(approvals.id, w.approvalId));
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, w.messageId));
    const changes = await changesOf(w.accountId);

    // ── WHAT THE CLAIM-SHAPED WRITE GUARANTEES ────────────────────────────────────────────
    //
    // Exactly one of the two decisions takes effect, and the other is refused. Everything below
    // follows from that one property.
    expect(
      [firstRefused, rivalOutcome === "refused"].filter(Boolean).length,
      "both decisions were accepted — the approval was decided twice",
    ).toBe(1);

    // ONE `approval/update` change row. Two would tell every client the card resolved twice.
    expect(
      changes.filter((c) => c.entity === "approval" && c.op === "update").length,
      "the delta stream carries more than one resolution for one approval",
    ).toBe(1);

    // The stored decision and the mail's placement must agree. An approve re-routes to INBOX; a
    // reject leaves the message where it was. A row reading `rejected` over mail sitting in the
    // INBOX is the state that cannot be explained to a user.
    if (row!.status === "approved") {
      expect(fs!.desiredFolder).toBe("INBOX");
    } else {
      expect(
        fs!.desiredFolder,
        "the approval reads rejected but the message was re-routed by the approve that also landed",
      ).toBe("ohmail/Screener");
    }
  }, 60_000);

  /**
   * THE SAME RACE WITH THE PRESSES SWAPPED, WHICH IS THE WORSE HALF.
   *
   * When the APPROVE is the one that commits in the window and the REJECT commits last, the
   * reject's branch writes no `folder_state` at all — there is nothing for it to undo. So the
   * approve's re-route survives underneath a row that now reads `rejected`: the card says the
   * user turned the sender away, and the reconciler goes on to move their mail into the Ohbox on
   * the real IMAP server.
   */
  it("the swapped order leaves a rejected approval over mail that was filed anyway", async () => {
    const w = await newWorld();
    const svc = new ApprovalService({});

    const first = ctx(w.accountId);
    const realTransaction = db.transaction.bind(db);
    let ran = false;
    (first.db as unknown as { transaction: typeof realTransaction }).transaction = (async (
      cb: Parameters<typeof realTransaction>[0],
    ) => {
      if (!ran) {
        ran = true;
        try { await svc.decide(ctx(w.accountId), w.approvalId, { decision: "approve" }); } catch { /* refused is the pass */ }
      }
      return realTransaction(cb);
    }) as typeof realTransaction;

    try { await svc.decide(first, w.approvalId, { decision: "reject" }); } catch { /* refused is the pass */ }
    expect(ran, "the rival decision never ran — this test proved nothing").toBe(true);

    const [row] = await db.select().from(approvals).where(eq(approvals.id, w.approvalId));
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, w.messageId));

    expect(
      `${row!.status}/${fs!.desiredFolder}`,
      "the approval reads rejected while the message is filed to the Ohbox and queued for a real IMAP move",
    ).not.toBe("rejected/INBOX");
  }, 60_000);
});
