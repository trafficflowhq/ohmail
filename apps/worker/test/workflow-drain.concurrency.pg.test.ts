import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, asc, eq } from "drizzle-orm";
import { accounts, mailboxes, messages, drafts, workflows, workflowRuns, type LedgerTx, type Tx } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import type { SpendPort } from "@trafficflow/db";
import { fakeSpendPort, type FakeSpendPort } from "../../../packages/organizer/test/_spendport.js";
import { ledgerSources, sourceFor } from "@trafficflow/db";
import { PLANE_PRICES } from "../../../packages/services/test/helpers/plane-pricing.js";
import { runMigrations } from "@trafficflow/db/admin";
import { WorkflowExecutor, type DraftPort } from "@trafficflow/core";
import { workflowDrainPass } from "../src/workflow-cron.js";
import { pgTestUrl } from "@trafficflow/db/testing";

/**
 * The guarded-drain proof PGlite cannot host (it mirrors the `allocateSeq` concurrency test):
 * TWO worker drains on SEPARATE physical connections to a REAL Postgres (:5433) race
 * to claim the SAME pending run. The `pending → running` UPDATE re-asserts
 * `status='pending'`, so exactly ONE claims + runs it and the loser matches 0 rows —
 * a run can NEVER be double-executed even under the worker-cycle + cron-backstop race.
 *
 * ── ALSO LIVES HERE, AND NOT BY PREFERENCE ────────────────────────────────────────────
 *
 * The fix moves the charge and the paid model call OUT of the step transaction, so the debit
 * is committed BEFORE Anthropic is called. "Committed before" is a claim about visibility from
 * another connection, and **PGlite structurally cannot assert it**: it has one connection, on
 * which a read cannot tell committed from merely written-in-my-own-open-transaction. A
 * PGlite-only guard therefore passes just as happily against an implementation that still charges
 * inside the step tx — which is the defect. That is why the order guard is here.
 *
 * The overdraft guard is here for the sibling reason: `debitCredits`' `SELECT … FOR UPDATE` is the
 * serializer, and two callers cannot contend for one `credit_balances` row on a single connection.
 */
const URL = pgTestUrl(import.meta.url);
const NOW = new Date("2026-07-28T12:00:00Z");

/**
 * WHAT A FIXTURE BALANCE HAS TO BE, now that debits are WEIGHTED — the same derivation the
 * PGlite twin (`ai-metering.test.ts`) documents. Every balance here was written against a price
 * of 1; since the ratified card made the schedule per-reason (a workflow step is the program's
 * card price for `workflow`), a flat 10 no longer buys the action under test and every
 * assertion failed as `insufficient` — a true statement about the fixture that says nothing about
 * the claim/charge/refund races this file exists to pin. Deriving the seed from the price keeps
 * each assertion's exact meaning (after n charges the balance is the remainder) and tracks the
 * schedule, so the next re-price cannot silently turn these back into `insufficient` tests.
 * This pg file was missed when the card landed BECAUSE it only runs against :5433 — the PGlite
 * twin went green on the same day this one went red.
 */
const STEP_COST = PLANE_PRICES.workflow;
const REMAINDER = 9;

const MOCK: DraftPort = { async draft() { return { subject: "Re:", body: "b", rationale: "r" }; } };

const sqlA = postgres(URL, { max: 5 });
const sqlB = postgres(URL, { max: 5 });
const dbA = brandDialect(drizzle(sqlA, { schema }), "pg");
const dbB = brandDialect(drizzle(sqlB, { schema }), "pg");

interface Seeded {
  accountId: string;
  messageId: string;
  gate: FakeSpendPort;
}

/**
 * An account with a spend budget and one ordinary message, on pool A.
 *
 * ONE PORT FOR BOTH DRAINS, and that is the production shape rather than a convenience: two
 * processes reach the SAME entitlements program, so the exclusivity and the budget they contend
 * for are its state. Two ports would give each drain its own budget and its own claim, which is
 * the arrangement every case below exists to prove is not what happens.
 */
async function seedFunded(credits: number): Promise<Seeded> {
  const [acct] = await dbA.insert(accounts).values({ name: "b25-pg" }).returning();
  const accountId = acct!.id;
  const [mb] = await dbA.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `g-${randomUUID().slice(0, 8)}@tf.example` }).returning();
  const dedup = `mid:${randomUUID()}`;
  const [m] = await dbA.insert(messages).values({
    accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
    subject: "s", fromAddress: "a@ex.example", snippet: "x", nativeLocator: { folder: "INBOX", ref: "1:1" },
  }).returning();
  const gate = fakeSpendPort();
  gate.exclusive();
  // A STEP'S PRICE IS ONE ASK, so a budget in credits is a budget in asks divided by the step
  // cost — which is 1 for `workflow` in the terms table. Stated rather than assumed, because a
  // second-priced action would make the arithmetic below wrong in a way nothing would catch.
  gate.budget(Math.floor(credits / STEP_COST));
  return { accountId, messageId: m!.id, gate };
}

async function enqueueDraftRun(w: Seeded, steps?: unknown[]): Promise<string> {
  const [wf] = await dbA.insert(workflows).values({
    accountId: w.accountId, name: "wf", enabled: true, trigger: { kind: "manual" },
    steps: steps ?? [{ tool: "draft_reply", args: { messageId: w.messageId } }],
  }).returning();
  const [run] = await dbA.insert(workflowRuns).values({
    accountId: w.accountId, workflowId: wf!.id, status: "pending", trigger: { kind: "manual" },
  }).returning();
  return run!.id;
}

/**
 * WHAT WAS ASKED AND WHAT IT ANSWERED, in the order it happened — the port's own record.
 *
 * `reason`/`source`/`delta` are kept so every expectation below reads as it did: a `workflow`
 * ask that answered `ok` is one charge of one credit under the source a ledger row would have
 * been keyed on, and a release with `refund: true` is the reversal.
 */
function ledgerOf(w: Seeded): Array<{ reason: string; source: string; delta: number }> {
  const charges = w.gate.spends
    .filter((c) => c.accountId === w.accountId && c.outcome.verdict === "ok")
    .map((c) => ({ reason: `debit_${c.action}`, source: c.source, delta: -1 }));
  const refunds = w.gate.releases
    .filter((r) => r.accountId === w.accountId && r.refund)
    .map((r) => ({ reason: "refund", source: `refund:${sourceFor(r.action, r.attemptKey)}`, delta: 1 }));
  return [...charges, ...refunds];
}

// FILE-SCOPED, not per-describe: both pools are shared by every block below, and a
// `describe`-scoped `afterAll` ends them as soon as the FIRST block finishes — which fails the
// rest of the file with `write CONNECTION_ENDED localhost:5433` rather than with anything about
// the property under test.
beforeAll(async () => { await runMigrations(URL); });
afterAll(async () => { await sqlA.end({ timeout: 5 }); await sqlB.end({ timeout: 5 }); });

describe("workflowDrainPass under real-Postgres concurrency", () => {
  it("two concurrent drains of the SAME pending run → exactly one runs it", async () => {
    const accountId = randomUUID();
    const [mb] = await dbA.insert(mailboxes).values({ accountId, provider: "imap", address: "g@tf.example" }).returning();
    const dedup = `mid:${randomUUID()}`;
    const [m] = await dbA.insert(messages).values({
      accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
      subject: "s", fromAddress: "a@ex.example", snippet: "x", nativeLocator: { folder: "INBOX", ref: "1:1" },
    }).returning();
    const [wf] = await dbA.insert(workflows).values({
      accountId, name: "wf", enabled: true, trigger: { kind: "manual" },
      steps: [{ tool: "draft_reply", args: { messageId: m!.id } }],
    }).returning();
    const [run] = await dbA.insert(workflowRuns).values({
      accountId, workflowId: wf!.id, status: "pending", trigger: { kind: "manual" },
    }).returning();

    const [ra, rb] = await Promise.all([
      workflowDrainPass(dbA as unknown as Tx, { drafter: MOCK, accountId }, NOW),
      workflowDrainPass(dbB as unknown as Tx, { drafter: MOCK, accountId }, NOW),
    ]);

    // Exactly ONE drain claimed + ran the run.
    expect(ra.drained + rb.drained).toBe(1);
    const [after] = await dbA.select().from(workflowRuns).where(eq(workflowRuns.id, run!.id));
    expect(after!.status).toBe("succeeded");
    // And exactly ONE draft — never double-executed.
    const d = await dbA.select().from(drafts).where(eq(drafts.accountId, accountId));
    expect(d).toHaveLength(1);
  });
});

describe("the paid call is OUTSIDE the charge's transaction (real Postgres, two pools)", () => {
  it("ORDER GUARD: the money is asked BEFORE the model, and the draft is not yet written", async () => {
    // THE ORDER, AND THE HALF PGLITE CANNOT MAKE. The drafter reads `drafts` over pool B — a
    // genuinely separate physical connection — at the exact moment `draft()` is executing, and
    // sees NOTHING: the step's writes are all on the far side of the model call, so a draft
    // visible here would mean the effect was stored before it existed.
    //
    // The paired positive is the spend: the port has already been asked and has already
    // answered, which is what makes this an ORDER guard rather than a "did we charge" guard.
    // Before that change the charge was taken inside the step transaction — the shape of the failure is
    // "no ask yet when the model runs", and no balance assertion could have distinguished it.
    const w = await seedFunded(STEP_COST + REMAINDER);
    const runId = await enqueueDraftRun(w);
    const source = ledgerSources.workflowStep(runId, 0);

    const seen: { debits?: Array<{ source: string }>; drafts?: unknown[] } = {};
    const observingDrafter: DraftPort = {
      async draft() {
        seen.debits = w.gate.spends
          .filter((c) => c.accountId === w.accountId && c.outcome.verdict === "ok")
          .map((c) => ({ source: c.source }));
        seen.drafts = await dbB.select().from(drafts).where(eq(drafts.accountId, w.accountId));
        return { subject: "Re:", body: "b", rationale: "r" };
      },
    };

    const res = await workflowDrainPass(
      dbA as unknown as Tx,
      { drafter: observingDrafter, credits: w.gate, accountId: w.accountId },
      NOW,
    );
    expect(res.drained).toBe(1);

    // Mid-call: the money was already asked for and granted…
    expect(seen.debits).toEqual([{ source }]);
    // …and the effect it pays for is not yet stored, read from ANOTHER CONNECTION.
    expect(seen.drafts).toEqual([]);

    // The step still completed normally afterwards — one charge, one draft, the remainder left.
    expect(ledgerOf(w).filter((r) => r.reason === "debit_workflow"))
      .toHaveLength(1);
    expect(await dbA.select().from(drafts).where(eq(drafts.accountId, w.accountId))).toHaveLength(1);
  });

  it("NO OVERDRAFT: a balance of exactly one step, two concurrent drains of two runs → one draft, one refusal, never negative", async () => {
    // The assertion the rejected first plan would fail. That plan proposed a READ-ONLY balance check
    // inside the step tx, then settling the debit after the model returned — which discards
    // `debitCredits`' `FOR UPDATE`, its under-lock sufficiency decision and its guarded UPDATE,
    // i.e. exactly the four layers the "No API cost without revenue behind it" invariant says must not be softened. It would have traded
    // "unpaid model call" for "bounded overdraft", and overdraft is not a trade against #10, it IS
    // #10. Two racing drains against a balance of one is where that shows up as a negative number.
    //
    // Real Postgres and two pools are required twice over: PGlite cannot host two callers
    // contending for the same `credit_balances` row, and it is the row lock that decides this.
    const w = await seedFunded(STEP_COST);
    const runA = await enqueueDraftRun(w);
    const runB = await enqueueDraftRun(w);

    await Promise.all([
      workflowDrainPass(dbA as unknown as Tx,
        { drafter: MOCK, credits: w.gate, accountId: w.accountId }, NOW),
      workflowDrainPass(dbB as unknown as Tx,
        { drafter: MOCK, credits: w.gate, accountId: w.accountId }, NOW),
    ]);

    const debits = ledgerOf(w).filter((r) => r.reason === "debit_workflow");
    expect(debits).toHaveLength(1);                      // one step's price in hand, one charge
    expect(await dbA.select().from(drafts).where(eq(drafts.accountId, w.accountId))).toHaveLength(1);

    // Exactly one run succeeded and exactly one was refused for the RIGHT reason.
    const runs = await dbA.select({ id: workflowRuns.id, status: workflowRuns.status, reason: workflowRuns.reason })
      .from(workflowRuns).where(eq(workflowRuns.accountId, w.accountId));
    expect(runs.map((r) => r.status).sort()).toEqual(["failed", "succeeded"]);
    expect(runs.find((r) => r.status === "failed")!.reason).toBe("insufficient_credits");
    expect([runA, runB].sort()).toEqual(runs.map((r) => r.id).sort());
  });

  it("two concurrent EXECUTIONS of the same step cannot double-charge it", async () => {
    // The drain's guarded `pending → running` claim already makes this unreachable through
    // `workflowDrainPass` (the test above proves it), so the step runner is driven DIRECTLY from two
    // pools to test the layer beneath the claim: the money. A future caller that loses the claim
    // race — or any re-queue that does not exist yet — must still not be able to pay twice.
    //
    // What holds it is the ledger key, not the claim: both attempts name
    // `workflow_run:<runId>:<stepIndex>`, and `credit_ledger_source_uq` — `UNIQUE (account_id,
    // source)` — admits one. The loser is told `duplicate` → proceed, charged nothing, which is
    // the free-retry contract, and the `workflow_dedup_key` ON CONFLICT keeps it to one draft.
    const w = await seedFunded(STEP_COST + REMAINDER);
    const runId = await enqueueDraftRun(w);
    const source = ledgerSources.workflowStep(runId, 0);
    await dbA.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, runId));
    const [row] = await dbA.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    const runRow = {
      id: runId, accountId: w.accountId, workflowId: row!.workflowId,
      stepCursor: 0, status: "running",
    };

    const exec = new WorkflowExecutor();
    await Promise.all([
      exec.runOne({ db: dbA as unknown as Tx, drafter: MOCK, credits: w.gate, now: () => NOW }, runRow),
      exec.runOne({ db: dbB as unknown as Tx, drafter: MOCK, credits: w.gate, now: () => NOW }, runRow),
    ]);

    const debits = ledgerOf(w).filter((r) => r.reason === "debit_workflow");
    expect(debits.map((r) => r.source)).toEqual([source]);        // ONE charge, no `~2`
    expect(await dbA.select().from(drafts).where(eq(drafts.accountId, w.accountId))).toHaveLength(1);
  });

  it("…and a failing model on both cannot double-refund it", async () => {
    // The mirror of the case above, and the reason it is not obviously safe: the fix gave this path a
    // refund, and two racing step runners hold two SEPARATE gate instances, so the in-process marker
    // that normally makes `refund` exactly-once is not shared between them.
    //
    // It holds at two further layers that do not care who asks. `UNIQUE (account_id, source)` on
    // `refund:<attempt>` admits one row, and the `credit_ledger_refund_origin` trigger refuses a
    // refund that does not name a real debit on this account — so a refund of nothing and a refund
    // of a refund are database errors. Net effect: the balance returns to exactly what it was.
    const w = await seedFunded(STEP_COST + REMAINDER);
    const runId = await enqueueDraftRun(w);
    const source = ledgerSources.workflowStep(runId, 0);
    await dbA.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, runId));
    const [row] = await dbA.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    const runRow = {
      id: runId, accountId: w.accountId, workflowId: row!.workflowId,
      stepCursor: 0, status: "running",
    };
    const boom: DraftPort = { async draft(): Promise<never> { throw new Error("anthropic 503"); } };

    const exec = new WorkflowExecutor();
    await Promise.all([
      exec.runOne({ db: dbA as unknown as Tx, drafter: boom, credits: w.gate, now: () => NOW }, runRow),
      exec.runOne({ db: dbB as unknown as Tx, drafter: boom, credits: w.gate, now: () => NOW }, runRow),
    ]);

    const rows = ledgerOf(w);
    expect(rows.filter((r) => r.reason === "debit_workflow").map((r) => r.source)).toEqual([source]);
    // At most ONE refund row, naming the one real debit — never two, never a refund of a refund.
    expect(rows.filter((r) => r.reason === "refund").map((r) => r.source))
      .toEqual([ledgerSources.refund(source)]);
    expect(await dbA.select().from(drafts).where(eq(drafts.accountId, w.accountId))).toEqual([]);
  });
});
