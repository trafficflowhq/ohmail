import type { WorkflowPattern } from "@ohmail/wire";
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, messages, workflows, workflowRuns, type Tx } from "@trafficflow/db";
import { deriveProposals } from "@trafficflow/core";
import { workflowTimeScanPass } from "../src/workflow-cron.js";

/**
 * PROPOSAL-STEPS-NEED-A-TARGET-BINDER, PINNED. A proposal stores an `event` trigger on its pattern's
 * sender and steps with no `messageId` — the step runner needs one per run, and nothing binds an
 * arriving message to an `event` workflow: the worker's only scan is the `time` one. So a
 * materialized, ENABLED proposal runs never. The first case states today's reading; the second is
 * the binder's acceptance, failing now. The binder slice turns the second into `it` and drops the
 * first — both move together or neither does.
 */
const NOW = new Date("2026-10-12T12:00:00Z");
const PATTERN: WorkflowPattern = {
  kind: "sender", senderAddress: "news@acme.test", senderDomain: "acme.test",
  destination: "ohmail/News", count: 5, provenance: "learning",
};

async function materializedWithMatchingMail(): Promise<{ db: Awaited<ReturnType<typeof makeTestDb>>; workflowId: string; messageId: string }> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const { proposals } = deriveProposals(
    [{ pattern: 0, name: "File acme", rationale: "five times", steps: [{ tool: "file_message" }] }], [PATTERN]);
  expect(proposals, "the derivation admitted nothing; the fixture is wrong, not the binder").toHaveLength(1);
  const p = proposals[0]!;
  // What `POST /workflows { fromProposalId }` writes, then the person's enable.
  const [wf] = await db.insert(workflows).values({
    accountId, name: p.name, trigger: p.trigger, steps: p.steps, enabled: true, provenance: "proposed",
  }).returning();
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "me@x.test" }).returning();
  const dedup = `mid:${randomUUID()}`;
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
    subject: "s", fromAddress: PATTERN.senderAddress!, snippet: "x", nativeLocator: { folder: "INBOX", ref: "1:1" },
  }).returning();
  await workflowTimeScanPass(db as unknown as Tx, { accountId }, NOW);
  return { db, workflowId: wf!.id, messageId: m!.id };
}

describe("PROPOSAL-STEPS-NEED-A-TARGET-BINDER", () => {
  it("today: an enabled proposal's event workflow enqueues no run for mail from its own sender", async () => {
    const { db, workflowId } = await materializedWithMatchingMail();
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflowId))).toHaveLength(0);
  });

  it.fails("the binder: matching mail enqueues a run whose trigger snapshot carries the message", async () => {
    const { db, workflowId, messageId } = await materializedWithMatchingMail();
    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflowId));
    expect(runs).toHaveLength(1);
    expect((runs[0]!.trigger as { messageId?: string }).messageId).toBe(messageId);
  });
});
