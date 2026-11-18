import type { WorkflowTrigger } from "@ohmail/wire";
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { workflows, workflowRuns, type Tx } from "@trafficflow/db";
import { workflowTimeScanPass } from "../src/workflow-cron.js";

const NOW = new Date("2026-07-28T12:00:00Z");
const PAST = new Date("2026-07-28T11:00:00Z").toISOString();
const FUTURE = new Date("2026-07-28T13:00:00Z").toISOString();

type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function seedTimeWorkflow(
  db: Db, over: { enabled?: boolean; trigger?: Record<string, unknown>; deletedAt?: Date | null } = {},
): Promise<{ accountId: string; workflowId: string }> {
  const accountId = randomUUID();
  const [wf] = await db.insert(workflows).values({
    accountId, name: "time wf", enabled: over.enabled ?? true,
    steps: [{ tool: "add_kb_entry", args: { title: "t", content: "c" } }],
    trigger: over.trigger ?? { kind: "time", nextRunAt: PAST },
    deletedAt: over.deletedAt ?? null,
  }).returning();
  return { accountId, workflowId: wf!.id };
}

const runsFor = (db: Db, workflowId: string) =>
  db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflowId));

describe("workflowTimeScanPass — due-scan enqueue", () => {
  it("a past nextRunAt enqueues exactly ONE pending run and CLEARS nextRunAt (one-shot)", async () => {
    const db = await makeTestDb();
    const { workflowId } = await seedTimeWorkflow(db);

    const res = await workflowTimeScanPass(db as unknown as Tx, {}, NOW);
    expect(res.enqueued).toBe(1);

    const runs = await runsFor(db, workflowId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("pending");
    expect(runs[0]!.trigger).toMatchObject({ kind: "time", nextRunAt: PAST });   // snapshot of the firing trigger

    // One-shot: nextRunAt cleared so it never fires again.
    const [wf] = await db.select().from(workflows).where(eq(workflows.id, workflowId));
    expect((wf!.trigger as WorkflowTrigger).nextRunAt).toBeUndefined();
  });

  it("a DOUBLE scan does not double-enqueue (nextRunAt already advanced)", async () => {
    const db = await makeTestDb();
    const { workflowId } = await seedTimeWorkflow(db);
    expect((await workflowTimeScanPass(db as unknown as Tx, {}, NOW)).enqueued).toBe(1);
    expect((await workflowTimeScanPass(db as unknown as Tx, {}, NOW)).enqueued).toBe(0);
    expect(await runsFor(db, workflowId)).toHaveLength(1);
  });

  it("a FUTURE nextRunAt is not due → no run enqueued", async () => {
    const db = await makeTestDb();
    const { workflowId } = await seedTimeWorkflow(db, { trigger: { kind: "time", nextRunAt: FUTURE } });
    expect((await workflowTimeScanPass(db as unknown as Tx, {}, NOW)).enqueued).toBe(0);
    expect(await runsFor(db, workflowId)).toHaveLength(0);
  });

  it("a recurring (intervalMs) trigger ADVANCES nextRunAt past now instead of clearing it", async () => {
    const db = await makeTestDb();
    const hourMs = 60 * 60 * 1000;
    const { workflowId } = await seedTimeWorkflow(db, { trigger: { kind: "time", nextRunAt: PAST, intervalMs: hourMs } });

    expect((await workflowTimeScanPass(db as unknown as Tx, {}, NOW)).enqueued).toBe(1);
    const [wf] = await db.select().from(workflows).where(eq(workflows.id, workflowId));
    const next = (wf!.trigger as WorkflowTrigger).nextRunAt!;
    expect(new Date(next).getTime()).toBeGreaterThan(NOW.getTime());   // advanced strictly past now
    // A second scan at the SAME now does not re-fire (the advanced nextRunAt is now future).
    expect((await workflowTimeScanPass(db as unknown as Tx, {}, NOW)).enqueued).toBe(0);
  });

  it("a DISABLED time workflow does not enqueue; a soft-DELETED one does not either", async () => {
    const db = await makeTestDb();
    const disabled = await seedTimeWorkflow(db, { enabled: false });
    const deleted = await seedTimeWorkflow(db, { deletedAt: NOW });
    const res = await workflowTimeScanPass(db as unknown as Tx, {}, NOW);
    expect(res.enqueued).toBe(0);
    expect(await runsFor(db, disabled.workflowId)).toHaveLength(0);
    expect(await runsFor(db, deleted.workflowId)).toHaveLength(0);
  });

  it("scopes to deps.accountId when provided", async () => {
    const db = await makeTestDb();
    const mine = await seedTimeWorkflow(db);
    const theirs = await seedTimeWorkflow(db);
    const res = await workflowTimeScanPass(db as unknown as Tx, { accountId: mine.accountId }, NOW);
    expect(res.enqueued).toBe(1);
    expect(await runsFor(db, theirs.workflowId)).toHaveLength(0);   // other account untouched
  });
});
