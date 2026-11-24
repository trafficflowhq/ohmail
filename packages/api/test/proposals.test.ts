import type { Db } from "@trafficflow/services";
import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { workflows, workflowProposals, idempotencyKeys } from "@trafficflow/db";
import { and, eq } from "drizzle-orm";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/** Insert an OPEN proposal row directly (the worker cron would normally write it). */
async function seedProposal(
  db: Db, accountId: string,
  over: { name?: string; steps?: unknown[]; trigger?: unknown } = {},
): Promise<string> {
  const [p] = await db.insert(workflowProposals).values({
    accountId,
    name: over.name ?? "File acme newsletters",
    rationale: "acme-com.example repeatedly routed to Feed",
    trigger: over.trigger ?? { kind: "manual" },
    steps: over.steps ?? [{ tool: "file_message", args: { toFolder: "ohmail/News" } }],
    sourcePattern: { kind: "sender", senderAddress: "news@acme-com.example", count: 7, provenance: "learning" },
    status: "open",
  }).returning();
  return p!.id;
}

describe("workflow proposals — list + dismiss", () => {
  it("GET /workflows/proposals lists OPEN proposals for the account", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await seedProposal(db, s.accountId);

    const res = await H(req("GET", "/workflows/proposals", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((p: { id: string }) => p.id)).toContain(id);
    expect(body.items[0].steps[0].tool).toBe("file_message");
  });

  it("POST /workflows/proposals/:id/dismiss → 204, then absent from the list; cross-account → 404", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });
    const id = await seedProposal(db, s.accountId);

    // Cross-account dismiss → 404 (not owner's proposal).
    expect((await H(req("POST", `/workflows/proposals/${id}/dismiss`, { bearer: other.token }), deps)).status).toBe(404);

    const del = await H(req("POST", `/workflows/proposals/${id}/dismiss`, { bearer: s.token }), deps);
    expect(del.status).toBe(204);
    expect((await (await H(req("GET", "/workflows/proposals", { bearer: s.token }), deps)).json()).items).toHaveLength(0);
  });
});

describe("materialize a proposal (POST /workflows { fromProposalId })", () => {
  it("→ 201 a DISABLED, provenance='proposed' workflow; the proposal becomes 'materialized'", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const proposalId = await seedProposal(db, s.accountId);

    const res = await H(req("POST", "/workflows", {
      bearer: s.token, body: JSON.stringify({ fromProposalId: proposalId }),
    }), deps);
    expect(res.status).toBe(201);
    const wf = await res.json();
    expect(wf.provenance).toBe("proposed");
    expect(wf.enabled).toBe(false);                    // INERT — never auto-enabled
    expect(wf.name).toBe("File acme newsletters");
    expect(wf.steps[0].tool).toBe("file_message");

    // The workflow is persisted disabled.
    const [row] = await db.select().from(workflows).where(eq(workflows.id, wf.id));
    expect(row!.enabled).toBe(false);
    expect(row!.provenance).toBe("proposed");

    // The proposal is consumed (no longer open) and leaves the proposals list.
    const [p] = await db.select().from(workflowProposals).where(eq(workflowProposals.id, proposalId));
    expect(p!.status).toBe("materialized");
    expect((await (await H(req("GET", "/workflows/proposals", { bearer: s.token }), deps)).json()).items).toHaveLength(0);
  });

  it("materializing the SAME proposal twice → 404 the second time (already consumed)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const proposalId = await seedProposal(db, s.accountId);
    expect((await H(req("POST", "/workflows", { bearer: s.token, body: JSON.stringify({ fromProposalId: proposalId }) }), deps)).status).toBe(201);
    expect((await H(req("POST", "/workflows", { bearer: s.token, body: JSON.stringify({ fromProposalId: proposalId }) }), deps)).status).toBe(404);
  });

  it("a CROSS-ACCOUNT proposal id → 404 (never materialized into the caller's account)", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });
    const proposalId = await seedProposal(db, owner.accountId);

    const res = await H(req("POST", "/workflows", {
      bearer: other.token, body: JSON.stringify({ fromProposalId: proposalId }),
    }), deps);
    expect(res.status).toBe(404);
    // Owner's proposal is untouched (still open).
    const [p] = await db.select().from(workflowProposals).where(eq(workflowProposals.id, proposalId));
    expect(p!.status).toBe("open");
  });

  it("a manually-authored create still works alongside the materialize path", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("POST", "/workflows", {
      bearer: s.token, body: JSON.stringify({ name: "Manual", steps: [{ tool: "add_kb_entry", args: {} }] }),
    }), deps);
    expect(res.status).toBe(201);
    expect((await res.json()).provenance).toBe("user");
  });
});

/*
 * A KEYED RETRY OF A MATERIALIZE REPLAYS ITS 201. The route is declared idempotent; the proposal
 * branch committed the workflow and the flip without the key, so a retry after a lost 201 ran the
 * handler again and answered 404 about a proposal it had itself consumed.
 */
describe("POST /workflows { fromProposalId } under an Idempotency-Key", () => {
  it("a retry under the same key answers the first 201, and one workflow exists", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const proposalId = await seedProposal(db, s.accountId);
    const post = () => H(req("POST", "/workflows", {
      bearer: s.token, headers: { "idempotency-key": "mat-1" }, body: JSON.stringify({ fromProposalId: proposalId }),
    }), deps);

    const first = await post();
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    const retry = await post();
    expect(retry.status, "the retry ran the handler again instead of replaying").toBe(201);
    expect(await retry.json()).toEqual(firstBody);

    const rows = await db.select().from(workflows).where(eq(workflows.accountId, s.accountId));
    expect(rows.map((r) => r.id)).toEqual([firstBody.id]);
    const [key] = await db.select().from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.accountId, s.accountId), eq(idempotencyKeys.key, "mat-1")));
    expect(key?.responseStatus).toBe(201);
  });

  it("POSITIVE CONTROL: a keyed inline create replays, and a new key makes a second workflow", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const post = (key: string) => H(req("POST", "/workflows", {
      bearer: s.token, headers: { "idempotency-key": key },
      body: JSON.stringify({ name: "Inline", steps: [{ tool: "add_kb_entry", args: {} }] }),
    }), deps);
    const a = await (await post("in-1")).json();
    expect(await (await post("in-1")).json()).toEqual(a);
    const b = await (await post("in-2")).json();
    expect(b.id).not.toBe(a.id);
    expect(await db.select().from(workflows).where(eq(workflows.accountId, s.accountId))).toHaveLength(2);
  });
});
