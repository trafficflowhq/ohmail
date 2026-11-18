import type { WorkflowTrigger } from "@ohmail/wire";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { workflows, workflowRuns, type Tx } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { workflowTimeScanPass, workflowDrainPass, unconfiguredDrafter } from "../src/workflow-cron.js";
import { pgTestUrl } from "@trafficflow/db/testing";

/**
 * The time-scan proof PGlite cannot host.
 *
 * `workflowTimeScanPass` compared a raw-SQL left side against a JS `Date`. Drizzle has no
 * column type to infer from a raw-SQL expression, so the Date was bound UNTYPED and
 * postgres.js threw `ERR_INVALID_ARG_TYPE: The "string" argument must be of type string …
 * Received an instance of Date` — on the FIRST select of the pass, against REAL Postgres,
 * on every single worker cycle. PGlite's driver accepts a Date happily, so the entire
 * existing suite was green while the live worker's workflow automation was dead: the throw
 * also skipped the `workflowDrainPass` that follows it inside the same try/catch, and the
 * worker cycle swallowed the error into `console.error`.
 *
 * This test runs the pass — and then the drain, in the same order the worker cycle runs
 * them — against the real :5433 Postgres. Restore the `lte(sql\`…\`, now)` form and it fails.
 */
const URL_ = pgTestUrl(import.meta.url);
const NOW = new Date("2026-07-28T12:00:00Z");
const PAST = new Date("2026-07-28T11:00:00Z").toISOString();
const FUTURE = new Date("2026-07-28T13:00:00Z").toISOString();

const sql = postgres(URL_, { max: 3 });
const db = brandDialect(drizzle(sql, { schema }), "pg");

describe("workflowTimeScanPass against REAL Postgres (the Date-binding regression)", () => {
  beforeAll(async () => { await runMigrations(URL_); }, 60000);
  afterAll(async () => { await sql.end({ timeout: 5 }); });

  async function seed(trigger: Record<string, unknown>): Promise<{ accountId: string; workflowId: string }> {
    const accountId = randomUUID();
    const [wf] = await db.insert(workflows).values({
      accountId, name: "time wf", enabled: true,
      steps: [{ tool: "add_kb_entry", args: { title: "t", content: "c" } }],
      trigger,
    }).returning();
    return { accountId, workflowId: wf!.id };
  }

  it("enqueues a DUE run without throwing, and the drain that follows it still runs", async () => {
    const due = await seed({ kind: "time", nextRunAt: PAST });
    const notDue = await seed({ kind: "time", nextRunAt: FUTURE });

    // Scoped by account exactly as the worker cycle scopes it (one served account per pass).
    const scan = await workflowTimeScanPass(db as unknown as Tx, { accountId: due.accountId }, NOW);
    expect(scan.enqueued).toBe(1);

    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, due.workflowId));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("pending");

    // One-shot: nextRunAt cleared; the future one untouched and NOT enqueued.
    const [wf] = await db.select().from(workflows).where(eq(workflows.id, due.workflowId));
    expect((wf!.trigger as WorkflowTrigger).nextRunAt).toBeUndefined();
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, notDue.workflowId))).toHaveLength(0);

    // The step that used to be unreachable because the scan threw first.
    const drain = await workflowDrainPass(
      db as unknown as Tx, { drafter: unconfiguredDrafter, accountId: due.accountId }, NOW,
    );
    expect(drain.drained).toBe(1);
    const after = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, due.workflowId));
    expect(after[0]!.status).not.toBe("pending");
  }, 60000);

  it("a recurring trigger advances instead of refiring, and a second scan enqueues nothing", async () => {
    const { accountId, workflowId } = await seed({ kind: "time", nextRunAt: PAST, intervalMs: 3_600_000 });

    expect((await workflowTimeScanPass(db as unknown as Tx, { accountId }, NOW)).enqueued).toBe(1);
    expect((await workflowTimeScanPass(db as unknown as Tx, { accountId }, NOW)).enqueued).toBe(0);
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflowId))).toHaveLength(1);

    const [wf] = await db.select().from(workflows).where(eq(workflows.id, workflowId));
    const next = (wf!.trigger as WorkflowTrigger).nextRunAt;
    expect(next).toBeDefined();
    expect(new Date(next!).getTime()).toBeGreaterThan(NOW.getTime());
  }, 60000);
});
