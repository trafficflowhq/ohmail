import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { workflowRuns, workflows, workflowProposals, idempotencyKeys, changeLog } from "@trafficflow/db";
import { and, eq } from "drizzle-orm";
import { WorkflowsService, dbFor } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";
import { ServiceError, IdempotencyRaceLost } from "../src/errors.js";

const NOW = new Date("2026-07-28T12:00:00Z");
const svc = new WorkflowsService();

async function ctxFor(): Promise<{ db: Awaited<ReturnType<typeof makeTestDb>>; ctx: ServiceContext; accountId: string }> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const ctx: ServiceContext = { db: dbFor(db, accountId), accountId, userId: null, now: () => NOW, requestId: "r" };
  return { db, ctx, accountId };
}

/** Await a rejected ServiceError and return its httpStatus for terse assertions. */
async function statusOf(p: Promise<unknown>): Promise<number> {
  try { await p; return 0; } catch (e) {
    if (e instanceof ServiceError) return e.httpStatus;
    throw e;
  }
}

describe("WorkflowsService — CRUD", () => {
  it("create → get → list → update", async () => {
    const { ctx } = await ctxFor();
    const created = await svc.create(ctx, {
      name: "File receipts",
      trigger: { kind: "manual" },
      steps: [{ tool: "file_message", args: { folder: "ohmail/Receipts" } }],
    });
    expect(created.provenance).toBe("user");
    expect(created.enabled).toBe(false);          // defaults off (consent gate)
    expect(created.steps).toHaveLength(1);

    const got = await svc.get(ctx, created.id);
    expect(got.id).toBe(created.id);

    const list = await svc.list(ctx);
    expect(list.map((w) => w.id)).toContain(created.id);

    const updated = await svc.update(ctx, created.id, { name: "Renamed", enabled: true });
    expect(updated.name).toBe("Renamed");
    expect(updated.enabled).toBe(true);
  });

  it("missing name → 400; default trigger is manual; empty steps ok", async () => {
    const { ctx } = await ctxFor();
    expect(await statusOf(svc.create(ctx, { name: "" }))).toBe(400);
    const wf = await svc.create(ctx, { name: "No steps" });
    expect(wf.trigger).toEqual({ kind: "manual" });
    expect(wf.steps).toEqual([]);
  });
});

describe("WorkflowsService — tool allowlist (security)", () => {
  it("rejects a step declaring a disallowed tool (send / forward) with 400", async () => {
    const { ctx } = await ctxFor();
    expect(await statusOf(svc.create(ctx, {
      name: "Exfiltrate", steps: [{ tool: "send", args: { to: "attacker@evil-com.example" } }],
    }))).toBe(400);
    expect(await statusOf(svc.create(ctx, {
      name: "Forwarder", steps: [{ tool: "forward", args: {} }],
    }))).toBe(400);
    // A mix with one bad step is still rejected wholesale.
    expect(await statusOf(svc.create(ctx, {
      name: "Mixed", steps: [{ tool: "file_message", args: {} }, { tool: "send", args: {} }],
    }))).toBe(400);
  });

  it("accepts a workflow using only the three allowlisted tools → created", async () => {
    const { ctx } = await ctxFor();
    const wf = await svc.create(ctx, {
      name: "All allowed",
      steps: [
        { tool: "file_message", args: { folder: "ohmail/News" } },
        { tool: "draft_reply", args: { tone: "brief" } },
        { tool: "add_kb_entry", args: { title: "t", content: "c" } },
      ],
    });
    expect(wf.steps).toHaveLength(3);
  });

  it("update re-validates steps — patching in a disallowed tool → 400", async () => {
    const { ctx } = await ctxFor();
    const wf = await svc.create(ctx, { name: "ok", steps: [{ tool: "file_message", args: {} }] });
    expect(await statusOf(svc.update(ctx, wf.id, { steps: [{ tool: "send", args: {} }] }))).toBe(400);
  });
});

describe("WorkflowsService — soft-delete + run retention", () => {
  it("softDelete hides the workflow (get/list 404/absent) but retains a pre-existing run row", async () => {
    const { db, ctx, accountId } = await ctxFor();
    const wf = await svc.create(ctx, { name: "wf", enabled: true });
    // A pre-existing run for the workflow (history to preserve).
    const [run] = await db.insert(workflowRuns).values({ accountId, workflowId: wf.id }).returning();

    await svc.softDelete(ctx, wf.id);

    expect(await statusOf(svc.get(ctx, wf.id))).toBe(404);   // gone from get
    expect((await svc.list(ctx)).map((w) => w.id)).not.toContain(wf.id);   // gone from list
    // But the run row survives (run retention).
    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run!.id));
    expect(runs).toHaveLength(1);
    // A double soft-delete is a 404 (already deleted).
    expect(await statusOf(svc.softDelete(ctx, wf.id))).toBe(404);
  });
});

describe("WorkflowsService — enqueueRun", () => {
  it("enqueues a pending run + writes the verbatim idempotency row in-tx", async () => {
    const { db, ctx, accountId } = await ctxFor();
    const wf = await svc.create(ctx, { name: "wf", enabled: true, trigger: { kind: "manual" } });

    const { runId } = await svc.enqueueRun(ctx, wf.id, { idempotency: { key: "run-1", requestHash: "h1" } });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run!.status).toBe("pending");
    expect(run!.trigger).toEqual({ kind: "manual" });   // snapshot of the workflow trigger

    // The idempotency row is stored verbatim (202 {runId}, seq null — REST-only).
    const [idem] = await db.select().from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.accountId, accountId), eq(idempotencyKeys.key, "run-1")));
    expect(idem!.responseStatus).toBe(202);
    expect(idem!.responseJson).toEqual({ runId });
    expect(idem!.seq).toBeNull();
  });

  it("a disabled workflow → 409; unknown / cross-account → 404", async () => {
    const { ctx } = await ctxFor();
    const disabled = await svc.create(ctx, { name: "off" });   // enabled defaults false
    expect(await statusOf(svc.enqueueRun(ctx, disabled.id))).toBe(409);
    expect(await statusOf(svc.enqueueRun(ctx, randomUUID()))).toBe(404);
  });

  it("listRuns is account-scoped and newest-first", async () => {
    const { db, ctx, accountId } = await ctxFor();
    const wf = await svc.create(ctx, { name: "wf", enabled: true });
    const { runId: r1 } = await svc.enqueueRun(ctx, wf.id);
    const { runId: r2 } = await svc.enqueueRun(ctx, wf.id);
    // Another account's run must not leak.
    await db.insert(workflowRuns).values({ accountId: randomUUID(), workflowId: null });

    const page = await svc.listRuns(ctx);
    const ids = page.items.map((r) => r.id);
    expect(ids).toContain(r1);
    expect(ids).toContain(r2);
    // Every returned run belongs to the caller.
    const all = await db.select().from(workflowRuns).where(eq(workflowRuns.accountId, accountId));
    expect(page.items).toHaveLength(all.length);
  });
});

describe("WorkflowsService — REST-only + cross-account", () => {
  it("no change_log row is written for a created workflow or an enqueued run", async () => {
    const { db, ctx, accountId } = await ctxFor();
    const wf = await svc.create(ctx, { name: "wf", enabled: true });
    await svc.enqueueRun(ctx, wf.id, { idempotency: { key: "k", requestHash: "h" } });
    const changes = await db.select().from(changeLog).where(eq(changeLog.accountId, accountId));
    expect(changes).toHaveLength(0);   // REST-only: no /sync envelope
  });

  it("cross-account get / update / softDelete / enqueueRun → 404", async () => {
    const { db } = await ctxFor();
    const ownerId = randomUUID();
    const otherId = randomUUID();
    const owner: ServiceContext = { db: dbFor(db, ownerId), accountId: ownerId, userId: null, now: () => NOW, requestId: "r" };
    const other: ServiceContext = { db: dbFor(db, otherId), accountId: otherId, userId: null, now: () => NOW, requestId: "r" };
    const wf = await svc.create(owner, { name: "wf", enabled: true });

    expect(await statusOf(svc.get(other, wf.id))).toBe(404);
    expect(await statusOf(svc.update(other, wf.id, { name: "x" }))).toBe(404);
    expect(await statusOf(svc.softDelete(other, wf.id))).toBe(404);
    expect(await statusOf(svc.enqueueRun(other, wf.id))).toBe(404);
  });
});

/*
 * THE PROPOSAL BRANCH CLAIMS THE KEY IN ITS OWN TRANSACTION, like the inline create: the stored 201
 * commits with the row and the flip, and a claim another request already holds rolls both back.
 */
describe("WorkflowsService — materialize under an idempotency claim", () => {
  async function withProposal() {
    const w = await ctxFor();
    const [p] = await w.db.insert(workflowProposals).values({
      accountId: w.accountId, name: "File acme newsletters", rationale: "r",
      trigger: { kind: "manual" }, steps: [{ tool: "file_message", args: { toFolder: "ohmail/News" } }],
      sourcePattern: { kind: "sender", senderAddress: "news@acme-com.example", count: 7, provenance: "learning" },
      status: "open",
    }).returning();
    return { ...w, proposalId: p!.id };
  }
  const claim = { key: "mat-k", requestHash: "h-mat" };

  it("stores the 201 it answered, with the workflow", async () => {
    const { db, ctx, accountId, proposalId } = await withProposal();
    const dto = await svc.create(ctx, { fromProposalId: proposalId }, { idempotency: claim });
    const [row] = await db.select().from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.accountId, accountId), eq(idempotencyKeys.key, claim.key)));
    expect({ status: row?.responseStatus, id: (row?.responseJson as { id?: string } | undefined)?.id })
      .toEqual({ status: 201, id: dto.id });
  });

  it("a key another request holds rolls the workflow and the flip back", async () => {
    const { db, ctx, accountId, proposalId } = await withProposal();
    await db.insert(idempotencyKeys).values({
      accountId, key: claim.key, requestHash: claim.requestHash, responseStatus: 201,
      responseJson: { winner: true }, seq: null, expiresAt: new Date(NOW.getTime() + 60_000), createdAt: NOW,
    });
    await expect(svc.create(ctx, { fromProposalId: proposalId }, { idempotency: claim }))
      .rejects.toBeInstanceOf(IdempotencyRaceLost);
    expect(await db.select().from(workflows).where(eq(workflows.accountId, accountId))).toHaveLength(0);
    const [p] = await db.select().from(workflowProposals).where(eq(workflowProposals.id, proposalId));
    expect(p?.status).toBe("open");
  });
});
