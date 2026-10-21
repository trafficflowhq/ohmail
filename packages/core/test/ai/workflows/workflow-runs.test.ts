import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  mailboxes, messages, folderState, drafts, kbEntries, auditLog,
  workflows, workflowRuns, changeLog, threads, type Tx,
} from "@trafficflow/db";
import { makeSonnetDrafter, WorkflowExecutor, type AnthropicLike, type WorkflowRunRow } from "@trafficflow/core";
import type { DraftPort, WorkflowStep } from "@trafficflow/core";

const NOW = new Date("2026-07-28T12:00:00Z");
const runner = new WorkflowExecutor();

/** A mock DraftPort (no network) — records call count. */
function mockDrafter(body = "drafted body"): DraftPort & { calls: number } {
  const port = {
    calls: 0,
    async draft() {
      port.calls++;
      return { subject: "Re: hello", body, rationale: "grounded" };
    },
  };
  return port;
}

type Db = Awaited<ReturnType<typeof makeTestDb>>;
type MsgFlags = Partial<{
  noAi: boolean; noForward: boolean; noKb: boolean; priority: boolean; sensitivityCategory: string;
  /** Overridable so a case can seed the text it is about. Default: an ordinary invoice. */
  subject: string; snippet: string;
}>;

async function seedMessage(db: Db, accountId: string, mailboxId: string, flags: MsgFlags = {}): Promise<string> {
  const dedup = `mid:${randomUUID()}`;
  const [m] = await db.insert(messages).values({
    accountId, mailboxId, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
    subject: flags.subject ?? "Invoice 42", fromAddress: "vendor@example.com",
    snippet: flags.snippet ?? "please find attached",
    nativeLocator: { folder: "INBOX", ref: "1:5" },
    noAi: flags.noAi ?? false, noForward: flags.noForward ?? false, noKb: flags.noKb ?? false,
    priority: flags.priority ?? false, sensitivityCategory: flags.sensitivityCategory ?? null,
  }).returning();
  return m!.id;
}

async function seedAccount(db: Db): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "owner@example.com" }).returning();
  return { accountId, mailboxId: mb!.id };
}

async function seedWorkflowRun(
  db: Db, accountId: string, steps: WorkflowStep[],
): Promise<WorkflowRunRow> {
  const [wf] = await db.insert(workflows).values({
    accountId, name: "wf", enabled: true, steps, trigger: { kind: "manual" },
  }).returning();
  const [run] = await db.insert(workflowRuns).values({
    accountId, workflowId: wf!.id, status: "running", trigger: { kind: "manual" },
  }).returning();
  return { id: run!.id, accountId, workflowId: wf!.id, stepCursor: run!.stepCursor, status: "running" };
}

const deps = (db: Db, drafter: DraftPort) => ({ db: db as unknown as Tx, drafter, now: () => NOW });

/**
 * Cross-account targets: a step naming another account's message is refused before any tool runs.
 * `anySensitive` filters on the caller's account, so on its own it fails open for a stranger's id;
 * `anyForeign` asks the ownership question first, at the pre-flight and again per step.
 * Mutations that turn this red: drop the pre-flight `anyForeign` arm (the victim's folder_state is
 * written), drop the per-step arm too (the audit row lands), or flip `ne(messages.accountId, …)` to
 * `eq` (every owned run fails `not_owned`).
 */
describe("WorkflowExecutor — cross-account targets are refused", () => {
  it("a step naming ANOTHER account's message writes nothing and fails the whole run", async () => {
    const db = await makeTestDb();
    const mine = await seedAccount(db);
    const theirs = await seedAccount(db);
    const victimMsg = await seedMessage(db, theirs.accountId, theirs.mailboxId, {});
    const myMsg = await seedMessage(db, mine.accountId, mine.mailboxId, {});

    // Step 0 is mine and perfectly legitimate; step 1 names the victim's message. The pre-flight
    // must refuse the WHOLE run, so step 0's effect must not land either.
    const run = await seedWorkflowRun(db, mine.accountId, [
      { tool: "file_message", args: { messageId: myMsg, toFolder: "ohmail/News" } },
      { tool: "file_message", args: { messageId: victimMsg, toFolder: "ohmail/Screener" } },
    ]);

    const res = await runner.runOne(deps(db, mockDrafter()), run);
    expect(res).toEqual({ status: "failed", reason: "not_owned", stepIndex: -1 });

    // THE LOAD-BEARING ASSERTION: the victim's desired folder was never touched, so the worker
    // has nothing to move.
    expect(await db.select().from(folderState).where(eq(folderState.messageId, victimMsg)),
      "a stranger's mailbox must not acquire a pending move").toHaveLength(0);
    // And nothing of the attacker's own run committed either.
    expect(await db.select().from(folderState)).toHaveLength(0);
    expect(await db.select().from(auditLog).where(eq(auditLog.accountId, mine.accountId))).toHaveLength(0);
    expect(await db.select().from(changeLog).where(eq(changeLog.accountId, mine.accountId))).toHaveLength(0);
  });

  it("a run whose ONLY step is foreign is refused before any tool runs", async () => {
    const db = await makeTestDb();
    const mine = await seedAccount(db);
    const theirs = await seedAccount(db);
    const victimMsg = await seedMessage(db, theirs.accountId, theirs.mailboxId, {});

    const run = await seedWorkflowRun(db, mine.accountId, [
      { tool: "file_message", args: { messageId: victimMsg, toFolder: "ohmail/Receipts" } },
    ]);
    const res = await runner.runOne(deps(db, mockDrafter()), run);
    expect(res).toEqual({ status: "failed", reason: "not_owned", stepIndex: -1 });
    expect(await db.select().from(folderState)).toHaveLength(0);
  });

  it("a foreign message that is ALSO sensitivity-flagged still reports not_owned", async () => {
    // Ordering matters: ownership is asked first, so the refusal never reveals a flag on a
    // message the caller may not know exists.
    const db = await makeTestDb();
    const mine = await seedAccount(db);
    const theirs = await seedAccount(db);
    const victimMsg = await seedMessage(db, theirs.accountId, theirs.mailboxId, { noAi: true });

    const run = await seedWorkflowRun(db, mine.accountId, [
      { tool: "file_message", args: { messageId: victimMsg, toFolder: "ohmail/News" } },
    ]);
    const res = await runner.runOne(deps(db, mockDrafter()), run);
    expect(res, "ownership is decided before sensitivity").toMatchObject({ status: "failed", reason: "not_owned" });
  });

  it("does not disturb a legitimate run — every target owned, every step applies", async () => {
    const db = await makeTestDb();
    const mine = await seedAccount(db);
    // A second account exists in the same store, so the predicate is doing real work rather than
    // passing because there is nobody else.
    const theirs = await seedAccount(db);
    await seedMessage(db, theirs.accountId, theirs.mailboxId, {});
    const a = await seedMessage(db, mine.accountId, mine.mailboxId, {});
    const b = await seedMessage(db, mine.accountId, mine.mailboxId, {});

    const run = await seedWorkflowRun(db, mine.accountId, [
      { tool: "file_message", args: { messageId: a, toFolder: "ohmail/News" } },
      { tool: "file_message", args: { messageId: b, toFolder: "ohmail/Receipts" } },
    ]);
    const res = await runner.runOne(deps(db, mockDrafter()), run);
    expect(res.status, "an owned run must still complete").toBe("succeeded");
    expect(await db.select().from(folderState)).toHaveLength(2);
  });
});

describe("WorkflowExecutor — whole-run sensitivity pre-flight", () => {
  // Each sensitivity flag independently REFUSES the whole run and acts on NOTHING.
  const flagCases: Array<[string, MsgFlags]> = [
    ["no_ai", { noAi: true }],
    ["no_forward", { noForward: true }],
    ["no_kb", { noKb: true }],
    ["sensitivity_category", { sensitivityCategory: "financial" }],
    ["priority", { priority: true }],
  ];

  for (const [label, flags] of flagCases) {
    it(`refuses the run when a targeted message is ${label} → failed:sensitive, nothing acted on`, async () => {
      const db = await makeTestDb();
      const { accountId, mailboxId } = await seedAccount(db);
      const msgId = await seedMessage(db, accountId, mailboxId, flags);
      // A multi-step run whose FIRST step is reversible + safe, but a LATER step targets
      // the sensitive message — the pre-flight must refuse the ENTIRE run (not just that step).
      const safeMsg = await seedMessage(db, accountId, mailboxId, {});
      const run = await seedWorkflowRun(db, accountId, [
        { tool: "file_message", args: { messageId: safeMsg, toFolder: "ohmail/News" } },
        { tool: "draft_reply", args: { messageId: msgId } },
      ]);

      const drafter = mockDrafter();
      const res = await runner.runOne(deps(db, drafter), run);

      expect(res).toEqual({ status: "failed", reason: "sensitive", stepIndex: -1 });
      const [after] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
      expect(after!.status).toBe("failed");
      expect(after!.reason).toBe("sensitive");
      expect(after!.stepCursor).toBe(0);

      // NOTHING was acted on: no folder_state, no draft, no kb row, no audit_log, no change_log.
      expect(await db.select().from(folderState)).toHaveLength(0);
      expect(await db.select().from(drafts)).toHaveLength(0);
      expect(await db.select().from(kbEntries)).toHaveLength(0);
      expect(await db.select().from(auditLog).where(eq(auditLog.accountId, accountId))).toHaveLength(0);
      expect(await db.select().from(changeLog).where(eq(changeLog.accountId, accountId))).toHaveLength(0);
      expect(drafter.calls).toBe(0);   // the drafter never saw the sensitive message
    });
  }
});

describe("WorkflowExecutor — reversible steps apply + audit_log inverse", () => {
  it("file_message sets desired folder + emits a message move change + an audit inverse", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId } = await seedAccount(db);
    const msgId = await seedMessage(db, accountId, mailboxId, {});
    const run = await seedWorkflowRun(db, accountId, [
      { tool: "file_message", args: { messageId: msgId, toFolder: "ohmail/Receipts" } },
    ]);

    const res = await runner.runOne(deps(db, mockDrafter()), run);
    expect(res.status).toBe("succeeded");

    // Desired-state handoff (NEVER IMAP): folder_state desired set, observed preserved.
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, msgId));
    expect(fs!.desiredFolder).toBe("ohmail/Receipts");
    expect(fs!.observedFolder).toBe("INBOX");
    expect(fs!.reconcileStatus).toBe("pending");

    // The move effect syncs as a `message` move change.
    const moves = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityType, "message")));
    expect(moves).toHaveLength(1);
    expect(moves[0]!.op).toBe("move");
    expect(moves[0]!.meta).toMatchObject({ from: "INBOX", to: "ohmail/Receipts" });

    // An audit_log inverse re-sets desired to the PRIOR folder (INBOX).
    const audits = await db.select().from(auditLog).where(eq(auditLog.accountId, accountId));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("workflow_step");
    expect(audits[0]!.inverse).toMatchObject({ tool: "file_message", messageId: msgId, toFolder: "INBOX" });
  });

  it("add_kb_entry inserts a kb row (REST-only) + an audit inverse", async () => {
    const db = await makeTestDb();
    const { accountId } = await seedAccount(db);
    const run = await seedWorkflowRun(db, accountId, [
      { tool: "add_kb_entry", args: { title: "Refund policy", content: "30 days" } },
    ]);

    expect((await runner.runOne(deps(db, mockDrafter()), run)).status).toBe("succeeded");

    const kb = await db.select().from(kbEntries).where(eq(kbEntries.accountId, accountId));
    expect(kb).toHaveLength(1);
    expect(kb[0]!.title).toBe("Refund policy");
    // kb is REST-only — no change_log for the entry.
    expect(await db.select().from(changeLog).where(eq(changeLog.accountId, accountId))).toHaveLength(0);
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.accountId, accountId));
    expect(audit!.inverse).toMatchObject({ tool: "add_kb_entry", kbEntryId: kb[0]!.id });
  });

  it("draft_reply calls the injected DraftPort + stores a draft (never sent) + emits a draft change", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId } = await seedAccount(db);
    const msgId = await seedMessage(db, accountId, mailboxId, {});
    const run = await seedWorkflowRun(db, accountId, [
      { tool: "draft_reply", args: { messageId: msgId } },
    ]);

    const drafter = mockDrafter();
    expect((await runner.runOne(deps(db, drafter), run)).status).toBe("succeeded");
    expect(drafter.calls).toBe(1);

    const d = await db.select().from(drafts).where(eq(drafts.accountId, accountId));
    expect(d).toHaveLength(1);
    expect(d[0]!.status).toBe("draft");          // STORED, never auto-sent
    expect(d[0]!.body).toBe("drafted body");
    // BOTH HALVES. The send path only builds a `multipart/alternative` when the markup is
    // there, so a null here is a workflow-drafted reply that leaves as plain text while the
    // same reply written by hand leaves as both.
    expect(d[0]!.html).toBe("<p>drafted body</p>");
    expect(d[0]!.inReplyToMessageId).toBe(msgId);
    // The draft EFFECT syncs as a `draft` create change.
    const changes = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityType, "draft")));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.op).toBe("create");
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.accountId, accountId));
    expect(audit!.inverse).toMatchObject({ tool: "draft_reply", draftId: d[0]!.id });
  });

  it("a multi-paragraph reply keeps its shape in the markup and its words in the text", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId } = await seedAccount(db);
    const msgId = await seedMessage(db, accountId, mailboxId, {});
    const run = await seedWorkflowRun(db, accountId, [
      { tool: "draft_reply", args: { messageId: msgId } },
    ]);

    const body = "Hi Alice\n\nMonday works.\nI will send the file.\n\nBest,\nBob";
    expect((await runner.runOne(deps(db, mockDrafter(body)), run)).status).toBe("succeeded");

    const [d] = await db.select().from(drafts).where(eq(drafts.accountId, accountId));
    // The blank line between paragraphs is an empty paragraph and a soft break is a `<br />`;
    // collapsing the two would lose the gap on the way back to text and the halves would then
    // disagree about where the message breathes.
    expect(d!.html).toBe(
      "<p>Hi Alice</p><p></p><p>Monday works.<br />I will send the file.</p><p></p><p>Best,<br />Bob</p>",
    );
    // And the text half is still exactly the model's words.
    expect(d!.body).toBe(body);
  });
});

describe("WorkflowExecutor — per-step idempotency", () => {
  it("re-draining the SAME run (cursor reset) does not duplicate the draft / kb row", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId } = await seedAccount(db);
    const msgId = await seedMessage(db, accountId, mailboxId, {});
    const run = await seedWorkflowRun(db, accountId, [
      { tool: "add_kb_entry", args: { title: "t", content: "c" } },
      { tool: "draft_reply", args: { messageId: msgId } },
    ]);

    const drafter = mockDrafter();
    expect((await runner.runOne(deps(db, drafter), run)).status).toBe("succeeded");
    expect(drafter.calls).toBe(1);

    // Simulate a crash-resume / re-drain: the cursor is lost (reset to 0) but the effects
    // + their audit rows already committed. Re-running must NOT duplicate anything.
    await db.update(workflowRuns).set({ stepCursor: 0, status: "running" }).where(eq(workflowRuns.id, run.id));
    const res2 = await runner.runOne(deps(db, drafter), { ...run, stepCursor: 0 });
    expect(res2.status).toBe("succeeded");

    expect(await db.select().from(kbEntries).where(eq(kbEntries.accountId, accountId))).toHaveLength(1);
    expect(await db.select().from(drafts).where(eq(drafts.accountId, accountId))).toHaveLength(1);
    // The idempotency gate short-circuited: the drafter was NOT called again, no dup audit rows.
    expect(drafter.calls).toBe(1);
    expect(await db.select().from(auditLog).where(eq(auditLog.accountId, accountId))).toHaveLength(2);
    const [after] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
    expect(after!.stepCursor).toBe(2);   // cursor advanced back through the skipped steps
  });
});

describe("WorkflowExecutor — failure, no auto-rollback", () => {
  it("a throwing step marks the run failed + records the stepIndex; earlier effects remain", async () => {
    const db = await makeTestDb();
    const { accountId } = await seedAccount(db);
    // Step 0 succeeds (kb write); step 1 targets a non-existent message → target_missing throw.
    const run = await seedWorkflowRun(db, accountId, [
      { tool: "add_kb_entry", args: { title: "kept", content: "survives" } },
      { tool: "draft_reply", args: { messageId: randomUUID() } },
    ]);

    const res = await runner.runOne(deps(db, mockDrafter()), run);
    expect(res).toMatchObject({ status: "failed", stepIndex: 1 });

    const [after] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
    expect(after!.status).toBe("failed");
    expect(after!.reason).toBe("target_missing");
    expect(after!.stepCursor).toBe(1);   // step 0 committed + advanced; step 1 rolled back
    // No auto-rollback: step 0's kb row + its audit inverse remain.
    expect(await db.select().from(kbEntries).where(eq(kbEntries.accountId, accountId))).toHaveLength(1);
    expect(await db.select().from(auditLog).where(eq(auditLog.accountId, accountId))).toHaveLength(1);
  });
});

/**
 * The model-sink screen on the two automatic sinks (draft_reply, add_kb_entry): a credential split
 * across subject and snippet passes each per-field flag, so the joined input is screened; the step
 * fails with the class in its reason and neither sink writes. Mutation: skip the screen in
 * `WorkflowExecutor` and the refusals here go red.
 */
describe("the model-sink screen refuses a credential split across two fields", () => {
  /** Invented, in the shape providers use. Each half is admitted on its own — asserted below. */
  const SPLIT = { subject: "Your passphrase", snippet: "It is 481920, on the label." };

  it("draft_reply: the run fails with the class, the drafter is never called, no draft is stored", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId } = await seedAccount(db);
    const msgId = await seedMessage(db, accountId, mailboxId, SPLIT);
    const run = await seedWorkflowRun(db, accountId, [
      { tool: "draft_reply", args: { messageId: msgId } },
    ]);

    const drafter = mockDrafter();
    expect(await runner.runOne(deps(db, drafter), run))
      .toMatchObject({ status: "failed", reason: "credential_screened:credential_shape", stepIndex: 0 });
    expect(drafter.calls, "the model was asked anyway").toBe(0);
    expect(await db.select().from(drafts).where(eq(drafts.accountId, accountId))).toHaveLength(0);

    const [after] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
    expect(after!.reason).toBe("credential_screened:credential_shape");
  });

  it("draft_reply: refuses when the split is in the KB GROUNDING rather than the target", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId } = await seedAccount(db);
    const msgId = await seedMessage(db, accountId, mailboxId, {});
    await db.insert(kbEntries).values({
      accountId, title: SPLIT.subject, content: SPLIT.snippet,
    });
    const run = await seedWorkflowRun(db, accountId, [
      { tool: "draft_reply", args: { messageId: msgId } },
    ]);

    const drafter = mockDrafter();
    expect(await runner.runOne(deps(db, drafter), run))
      .toMatchObject({ status: "failed", reason: "credential_screened:credential_shape" });
    expect(drafter.calls).toBe(0);
  });

  it("draft_reply: an ordinary target with ordinary grounding still drafts", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId } = await seedAccount(db);
    const msgId = await seedMessage(db, accountId, mailboxId, {});
    await db.insert(kbEntries).values({
      accountId, title: "Refund policy", content: "We refund within 30 days of delivery.",
    });
    const run = await seedWorkflowRun(db, accountId, [
      { tool: "draft_reply", args: { messageId: msgId } },
    ]);

    const drafter = mockDrafter();
    expect((await runner.runOne(deps(db, drafter), run)).status).toBe("succeeded");
    expect(drafter.calls).toBe(1);
    expect(await db.select().from(drafts).where(eq(drafts.accountId, accountId))).toHaveLength(1);
  });

  it("add_kb_entry: the entry is NOT added — a stored credential is read back on every later draft", async () => {
    const db = await makeTestDb();
    const { accountId } = await seedAccount(db);
    const run = await seedWorkflowRun(db, accountId, [
      { tool: "add_kb_entry", args: { title: SPLIT.subject, content: SPLIT.snippet } },
    ]);

    expect(await runner.runOne(deps(db, mockDrafter()), run))
      .toMatchObject({ status: "failed", reason: "credential_screened:credential_shape", stepIndex: 0 });
    expect(await db.select().from(kbEntries).where(eq(kbEntries.accountId, accountId))).toHaveLength(0);
    expect(await db.select().from(auditLog).where(eq(auditLog.accountId, accountId))).toHaveLength(0);
  });

  it("add_kb_entry: refuses a split sourced from a MESSAGE's subject and snippet", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId } = await seedAccount(db);
    const msgId = await seedMessage(db, accountId, mailboxId, SPLIT);
    const run = await seedWorkflowRun(db, accountId, [
      { tool: "add_kb_entry", args: { fromMessageId: msgId } },
    ]);

    expect((await runner.runOne(deps(db, mockDrafter()), run)).status).toBe("failed");
    expect(await db.select().from(kbEntries).where(eq(kbEntries.accountId, accountId))).toHaveLength(0);
  });

  it("the screen precedes the CHARGE: a refused draft spends nothing", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId } = await seedAccount(db);
    const msgId = await seedMessage(db, accountId, mailboxId, SPLIT);
    const run = await seedWorkflowRun(db, accountId, [
      { tool: "draft_reply", args: { messageId: msgId } },
    ]);

    const spends: string[] = [];
    const credits = {
      async spend(_a: string, action: string) { spends.push(action); return { verdict: "ok" as const, attempt: "x" }; },
      async release(): Promise<"settled"> { /* nothing to hand back — nothing was taken */ return "settled"; },
    };
    const withCredits = {
      ...deps(db, mockDrafter()),
      credits: credits as unknown as NonNullable<Parameters<typeof runner.runOne>[0]["credits"]>,
    };
    expect((await runner.runOne(withCredits, run)).status).toBe("failed");
    expect(spends, "the customer was charged for a draft we refused to make").toEqual([]);
  });

  it("each half of the split is admitted on its own — so the case is about the JOIN", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId } = await seedAccount(db);
    for (const half of [{ subject: SPLIT.subject }, { snippet: SPLIT.snippet }]) {
      const msgId = await seedMessage(db, accountId, mailboxId, half);
      const run = await seedWorkflowRun(db, accountId, [
        { tool: "draft_reply", args: { messageId: msgId } },
      ]);
      expect((await runner.runOne(deps(db, mockDrafter()), run)).status, JSON.stringify(half))
        .toBe("succeeded");
    }
  });
});

/**
 * A declined draft fails its run as `model_declined`, never the catch-all `error`. Mutation: delete
 * the `ModelDeclinedError` arm in `WorkflowExecutor`'s draft step and the reason reads `error`.
 */
describe("WorkflowExecutor — a declined draft_reply", () => {
  it("fails the run as `model_declined`, at the step, and stores no draft", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId } = await seedAccount(db);
    const msgId = await seedMessage(db, accountId, mailboxId);
    const run = await seedWorkflowRun(db, accountId, [{ tool: "draft_reply", args: { messageId: msgId } }]);
    // A refusal answers HTTP 200 with no content; the stop reason says why.
    const refusing = { messages: { create: async () => ({
      id: "msg_refusal", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [],
      stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms", explanation: "declined" },
      usage: { input_tokens: 900, output_tokens: 0 },
    }) } } as AnthropicLike;
    const declining: DraftPort = makeSonnetDrafter(refusing);

    expect(await runner.runOne(deps(db, declining), run))
      .toMatchObject({ status: "failed", reason: "model_declined", stepIndex: 0 });
    expect(await db.select().from(drafts).where(eq(drafts.accountId, accountId))).toHaveLength(0);
    const [after] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
    expect(after!.reason).toBe("model_declined");
  });
});

/**
 * Sensitive mail never becomes knowledge or grounding. `anySensitive` refuses a run whose step
 * names a `no_kb` message (as its target or as `fromMessageId`), and the drafter's thread context
 * leaves `no_kb` siblings out. Mutations: drop `eq(messages.noKb, true)` from `anySensitive` (the
 * first case and the flag case above go red); drop `eq(messages.noKb, false)` from the sibling
 * query (the third case goes red).
 */
describe("WorkflowExecutor — no_kb mail never becomes knowledge or grounding", () => {
  it("add_kb_entry sourced from a no_kb message is refused and writes no entry", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId } = await seedAccount(db);
    const msgId = await seedMessage(db, accountId, mailboxId, { noKb: true });
    const run = await seedWorkflowRun(db, accountId, [{ tool: "add_kb_entry", args: { fromMessageId: msgId } }]);
    expect(await runner.runOne(deps(db, mockDrafter()), run)).toEqual({ status: "failed", reason: "sensitive", stepIndex: -1 });
    expect(await db.select().from(kbEntries)).toHaveLength(0);
    expect(await db.select().from(auditLog).where(eq(auditLog.accountId, accountId))).toHaveLength(0);
  });

  it("control: add_kb_entry sourced from an ordinary message stores its subject and snippet", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId } = await seedAccount(db);
    const msgId = await seedMessage(db, accountId, mailboxId, {});
    const run = await seedWorkflowRun(db, accountId, [{ tool: "add_kb_entry", args: { fromMessageId: msgId } }]);
    expect((await runner.runOne(deps(db, mockDrafter()), run)).status).toBe("succeeded");
    const kb = await db.select().from(kbEntries).where(eq(kbEntries.accountId, accountId));
    expect(kb.map((k) => [k.title, k.content])).toEqual([["Invoice 42", "please find attached"]]);
  });

  it("a no_kb sibling never reaches the drafter; an ordinary sibling does", async () => {
    const db = await makeTestDb();
    const { accountId, mailboxId } = await seedAccount(db);
    const [t] = await db.insert(threads).values({ accountId, subject: "Invoice 42" }).returning();
    const target = await seedMessage(db, accountId, mailboxId, {});
    const hidden = await seedMessage(db, accountId, mailboxId, { noKb: true, snippet: "NOKB-SIBLING" });
    const shown = await seedMessage(db, accountId, mailboxId, { snippet: "ORDINARY-SIBLING" });
    for (const id of [target, hidden, shown]) await db.update(messages).set({ threadId: t!.id }).where(eq(messages.id, id));
    const seen: string[] = [];
    const drafter: DraftPort = {
      async draft(input) {
        seen.push(...input.context.threadMessages.map((m) => m.snippet));
        return { subject: "Re", body: "ok", rationale: "r" };
      },
    };
    const run = await seedWorkflowRun(db, accountId, [{ tool: "draft_reply", args: { messageId: target } }]);
    expect((await runner.runOne(deps(db, drafter), run)).status).toBe("succeeded");
    expect(seen).toContain("ORDINARY-SIBLING");
    expect(seen).not.toContain("NOKB-SIBLING");
  });
});
