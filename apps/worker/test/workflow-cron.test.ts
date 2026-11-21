import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  mailboxes, messages, folderState, drafts, workflows, workflowRuns, type Tx,
} from "@trafficflow/db";
import type { DraftPort } from "@trafficflow/core";
import { workflowDrainPass, unconfiguredDrafter } from "../src/workflow-cron.js";

const NOW = new Date("2026-07-28T12:00:00Z");

const MOCK: DraftPort = {
  async draft() { return { subject: "Re:", body: "b", rationale: "r" }; },
};

type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function seed(db: Db) {
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "g@tf.example" }).returning();
  const dedup = `mid:${randomUUID()}`;
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
    subject: "s", fromAddress: "a@ex.example", snippet: "x", nativeLocator: { folder: "INBOX", ref: "1:1" },
  }).returning();
  return { accountId, mailboxId: mb!.id, messageId: m!.id };
}

async function enqueuePending(db: Db, accountId: string, steps: unknown[]): Promise<string> {
  const [wf] = await db.insert(workflows).values({
    accountId, name: "wf", enabled: true, steps, trigger: { kind: "manual" },
  }).returning();
  const [run] = await db.insert(workflowRuns).values({
    accountId, workflowId: wf!.id, status: "pending", trigger: { kind: "manual" },
  }).returning();
  return run!.id;
}

describe("workflowDrainPass", () => {
  it("claims a pending run, runs its steps, and marks it succeeded", async () => {
    const db = await makeTestDb();
    const { accountId, messageId } = await seed(db);
    const runId = await enqueuePending(db, accountId, [
      { tool: "file_message", args: { messageId, toFolder: "ohmail/News" } },
      { tool: "draft_reply", args: { messageId } },
    ]);

    const res = await workflowDrainPass(db as unknown as Tx, { drafter: MOCK }, NOW);
    expect(res.drained).toBe(1);

    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run!.status).toBe("succeeded");
    // Effects applied: folder_state desired + a stored draft.
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
    expect(fs!.desiredFolder).toBe("ohmail/News");
    expect(await db.select().from(drafts).where(eq(drafts.accountId, accountId))).toHaveLength(1);
  });

  it("scopes to deps.accountId — a run for another account is left pending", async () => {
    const db = await makeTestDb();
    const mine = await seed(db);
    const theirs = await seed(db);
    await enqueuePending(db, mine.accountId, [{ tool: "add_kb_entry", args: { title: "t", content: "c" } }]);
    const theirRun = await enqueuePending(db, theirs.accountId, [{ tool: "add_kb_entry", args: { title: "t", content: "c" } }]);

    const res = await workflowDrainPass(db as unknown as Tx, { drafter: MOCK, accountId: mine.accountId }, NOW);
    expect(res.drained).toBe(1);
    const [other] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, theirRun));
    expect(other!.status).toBe("pending");   // untouched — different account
  });

  it("GUARDED drain: once claimed, a second drain does not re-run the same run", async () => {
    const db = await makeTestDb();
    const { accountId, messageId } = await seed(db);
    const runId = await enqueuePending(db, accountId, [{ tool: "draft_reply", args: { messageId } }]);

    // First drain claims + runs it (pending → running → succeeded).
    expect((await workflowDrainPass(db as unknown as Tx, { drafter: MOCK }, NOW)).drained).toBe(1);
    // Second drain sees NO pending row → drains nothing; the run is untouched, no dup draft.
    expect((await workflowDrainPass(db as unknown as Tx, { drafter: MOCK }, NOW)).drained).toBe(0);
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run!.status).toBe("succeeded");
    expect(await db.select().from(drafts).where(eq(drafts.accountId, accountId))).toHaveLength(1);
  });

  it("the guarded pending→running UPDATE re-asserts status='pending' (a loser claims 0 rows)", async () => {
    const db = await makeTestDb();
    const { accountId } = await seed(db);
    const runId = await enqueuePending(db, accountId, []);

    // Winner flips pending → running.
    const won = await db.update(workflowRuns).set({ status: "running" })
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, "pending")))
      .returning({ id: workflowRuns.id });
    expect(won).toHaveLength(1);
    // Loser re-asserts status='pending' → matches 0 rows (cannot double-claim).
    const lost = await db.update(workflowRuns).set({ status: "running" })
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, "pending")))
      .returning({ id: workflowRuns.id });
    expect(lost).toHaveLength(0);
  });

  it("unconfiguredDrafter fails only the draft_reply step; the run is marked failed", async () => {
    const db = await makeTestDb();
    const { accountId, messageId } = await seed(db);
    const runId = await enqueuePending(db, accountId, [{ tool: "draft_reply", args: { messageId } }]);

    const res = await workflowDrainPass(db as unknown as Tx, { drafter: unconfiguredDrafter }, NOW);
    expect(res.drained).toBe(1);   // the run was claimed + attempted
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run!.status).toBe("failed");   // no live drafter wired
  });
});

it("drops the model step of a workflow disabled after enqueue", async () => {
  const db = await makeTestDb();
  const { accountId, messageId } = await seed(db);
  const runId = await enqueuePending(db, accountId, [{ tool: "draft_reply", args: { messageId } }]);
  await db.update(workflows).set({ enabled: false }).where(eq(workflows.accountId, accountId));
  let calls = 0;
  await workflowDrainPass(db as unknown as Tx, { drafter: {
    async draft(input) { calls++; return MOCK.draft(input); },
  } }, NOW);
  expect(calls).toBe(0);
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
  expect(run?.status).toBe("failed");
  expect(run?.reason).toBe("ai_unavailable");
  expect(run?.log).toEqual([expect.objectContaining({ reason: "ai_unavailable" })]);
});
