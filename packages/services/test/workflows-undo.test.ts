import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  mailboxes, messages, folderState, drafts, kbEntries, changeLog,
  workflows, workflowRuns, type Tx,
} from "@trafficflow/db";
import { WorkflowExecutor } from "@trafficflow/core";
import type { DraftPort, WorkflowStep } from "@trafficflow/core";
import { WorkflowsService, dbFor } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";
import { ServiceError } from "../src/errors.js";

const NOW = new Date("2026-07-28T12:00:00Z");
const svc = new WorkflowsService();
const workflowRunner = new WorkflowExecutor();
const MOCK: DraftPort = { async draft() { return { subject: "Re:", body: "b", rationale: "r" }; } };

type Db = Awaited<ReturnType<typeof makeTestDb>>;
const ctxFor = (db: Db, accountId: string): ServiceContext =>
  ({ db: dbFor(db, accountId), accountId, userId: null, now: () => NOW, requestId: "r" });

async function statusOf(p: Promise<unknown>): Promise<number> {
  try { await p; return 0; } catch (e) { if (e instanceof ServiceError) return e.httpStatus; throw e; }
}

/** Seed account+mailbox+message, an enabled workflow whose steps `buildSteps(messageId)`
 *  produces, and RUN it via the workflow runner. */
async function runWorkflow(
  db: Db, buildSteps: (messageId: string) => WorkflowStep[],
): Promise<{ accountId: string; messageId: string; runId: string }> {
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "g@tf.example" }).returning();
  const dedup = `mid:${randomUUID()}`;
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
    subject: "s", fromAddress: "a@ex.example", snippet: "x", nativeLocator: { folder: "INBOX", ref: "1:1" },
  }).returning();
  const steps = buildSteps(m!.id);
  const [wf] = await db.insert(workflows).values({
    accountId, name: "wf", enabled: true, steps, trigger: { kind: "manual" },
  }).returning();
  const [run] = await db.insert(workflowRuns).values({
    accountId, workflowId: wf!.id, status: "running", trigger: { kind: "manual" },
  }).returning();
  const res = await workflowRunner.runOne(
    { db: db as unknown as Tx, drafter: MOCK, now: () => NOW },
    { id: run!.id, accountId, workflowId: wf!.id, stepCursor: 0, status: "running" },
  );
  expect(res.status).toBe("succeeded");
  return { accountId, messageId: m!.id, runId: run!.id };
}

describe("WorkflowsService.undoRun", () => {
  it("replays inverses in reverse: file_message desired restored, kb entry deleted, run → undone", async () => {
    const db = await makeTestDb();
    const { accountId, messageId, runId } = await runWorkflow(db, (mid) => [
      { tool: "file_message", args: { messageId: mid, toFolder: "ohmail/News" } },
      { tool: "add_kb_entry", args: { title: "t", content: "c" } },
    ]);

    // Sanity: the run applied its effects.
    const [before] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
    expect(before!.desiredFolder).toBe("ohmail/News");
    expect(await db.select().from(kbEntries).where(eq(kbEntries.accountId, accountId))).toHaveLength(1);

    const dto = await svc.undoRun(ctxFor(db, accountId), runId);
    expect(dto.status).toBe("undone");

    // file_message inverse: desired re-set to the PRIOR folder (INBOX).
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
    expect(fs!.desiredFolder).toBe("INBOX");
    // add_kb_entry inverse: the entry is gone.
    expect(await db.select().from(kbEntries).where(eq(kbEntries.accountId, accountId))).toHaveLength(0);
    // The message-move EFFECT of the undo synced as a `message` move change.
    const moves = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityType, "message")));
    // one move from the run + one from the undo restore
    expect(moves.length).toBeGreaterThanOrEqual(2);
  });

  it("draft_reply undo deletes a still-'draft' row + emits a draft delete change", async () => {
    const db = await makeTestDb();
    const { accountId, messageId, runId } = await runWorkflow(db, (mid) => [
      { tool: "draft_reply", args: { messageId: mid } },
    ]);
    const [d] = await db.select().from(drafts).where(eq(drafts.accountId, accountId));
    expect(d!.status).toBe("draft");

    await svc.undoRun(ctxFor(db, accountId), runId);

    expect(await db.select().from(drafts).where(eq(drafts.accountId, accountId))).toHaveLength(0);
    const del = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityType, "draft"), eq(changeLog.op, "delete")));
    expect(del).toHaveLength(1);
  });

  it("draft_reply undo is a NO-OP if the draft already left 'draft' (can't unsend)", async () => {
    const db = await makeTestDb();
    const { accountId, messageId, runId } = await runWorkflow(db, (mid) => [
      { tool: "draft_reply", args: { messageId: mid } },
    ]);
    // Simulate the user sending it (3c): status is no longer 'draft'.
    await db.update(drafts).set({ status: "sent" }).where(eq(drafts.accountId, accountId));

    const dto = await svc.undoRun(ctxFor(db, accountId), runId);
    expect(dto.status).toBe("undone");
    // The draft is RETAINED (undo can't unsend) — still exactly one row, status 'sent'.
    const rows = await db.select().from(drafts).where(eq(drafts.accountId, accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("sent");
    // No draft-delete change was emitted.
    const del = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityType, "draft"), eq(changeLog.op, "delete")));
    expect(del).toHaveLength(0);
  });

  it("a cross-account / unknown run → 404", async () => {
    const db = await makeTestDb();
    const { runId } = await runWorkflow(db, () => [{ tool: "add_kb_entry", args: { title: "t", content: "c" } }]);
    expect(await statusOf(svc.undoRun(ctxFor(db, randomUUID()), runId))).toBe(404);   // other account
    expect(await statusOf(svc.undoRun(ctxFor(db, randomUUID()), randomUUID()))).toBe(404); // unknown
  });

  /**
   * The inverses are the `audit_log` rows written SO FAR, so an undo
   * accepted mid-run replays a PREFIX and then writes `undone` over a run whose remaining steps
   * keep landing with no inverse. Each non-terminal status is driven, and the refusal is measured
   * by what it did NOT do: the kb entry the first step created is still there and the run still
   * carries the status it had.
   */
  for (const held of ["running", "awaiting_approval"]) {
    it(`refuses a run the workflow runner still holds — ${held}`, async () => {
      const db = await makeTestDb();
      const { accountId, runId } = await runWorkflow(db, () => [
        { tool: "add_kb_entry", args: { title: "t", content: "c" } },
      ]);
      await db.update(workflowRuns).set({ status: held }).where(eq(workflowRuns.id, runId));

      expect(await statusOf(svc.undoRun(ctxFor(db, accountId), runId))).toBe(409);

      // NOTHING WAS UNDONE: the entry stands and the run kept its status.
      expect(await db.select().from(kbEntries).where(eq(kbEntries.accountId, accountId))).toHaveLength(1);
      const [after] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
      expect(after!.status).toBe(held);
    });
  }

  /** THE POSITIVE CONTROL, per admitted status: a run nothing is stepping through is undone. */
  for (const done of ["pending", "succeeded", "failed", "undone"]) {
    it(`undoes a run the workflow runner is not stepping through — ${done}`, async () => {
      const db = await makeTestDb();
      const { accountId, runId } = await runWorkflow(db, () => [
        { tool: "add_kb_entry", args: { title: "t", content: "c" } },
      ]);
      await db.update(workflowRuns).set({ status: done }).where(eq(workflowRuns.id, runId));

      const dto = await svc.undoRun(ctxFor(db, accountId), runId);
      expect(dto.status).toBe("undone");
      expect(await db.select().from(kbEntries).where(eq(kbEntries.accountId, accountId))).toHaveLength(0);
    });
  }
});
