import type { Db } from "@trafficflow/services";
import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { workflowRuns, changeLog, idempotencyKeys } from "@trafficflow/db";
import { and, eq } from "drizzle-orm";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

const runsFor = (db: Db, accountId: string) =>
  db.select().from(workflowRuns).where(eq(workflowRuns.accountId, accountId));

describe("workflows CRUD (§5.10, REST-only)", () => {
  it("create → get → list → PATCH → soft-delete (204, then 404/absent)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    const created = await H(req("POST", "/workflows", {
      bearer: s.token,
      body: JSON.stringify({
        name: "File receipts",
        trigger: { kind: "manual" },
        steps: [{ tool: "file_message", args: { folder: "ohmail/Receipts" } }],
      }),
    }), deps);
    expect(created.status).toBe(201);
    const wf = await created.json();
    expect(wf.provenance).toBe("user");
    expect(wf.enabled).toBe(false);
    // REST-only: no X-Sync-Seq on a workflow mutation.
    expect(created.headers.get("x-sync-seq")).toBeNull();

    expect((await H(req("GET", `/workflows/${wf.id}`, { bearer: s.token }), deps)).status).toBe(200);
    const listed = await (await H(req("GET", "/workflows", { bearer: s.token }), deps)).json();
    expect(listed.items.map((x: { id: string }) => x.id)).toContain(wf.id);

    const patched = await H(req("PATCH", `/workflows/${wf.id}`, {
      bearer: s.token, body: JSON.stringify({ name: "Renamed", enabled: true }),
    }), deps);
    expect(patched.status).toBe(200);
    expect((await patched.json()).name).toBe("Renamed");

    const del = await H(req("DELETE", `/workflows/${wf.id}`, { bearer: s.token }), deps);
    expect(del.status).toBe(204);
    expect((await H(req("GET", `/workflows/${wf.id}`, { bearer: s.token }), deps)).status).toBe(404);
    expect((await (await H(req("GET", "/workflows", { bearer: s.token }), deps)).json()).items).toHaveLength(0);
  });

  it("GET /workflows/proposals → { items: [] } (4b stub)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("GET", "/workflows/proposals", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).items).toEqual([]);
  });
});

describe("workflows — tool allowlist", () => {
  it("POST with a step {tool:'send'} / {tool:'forward'} → 400", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    for (const bad of ["send", "forward"]) {
      const res = await H(req("POST", "/workflows", {
        bearer: s.token, body: JSON.stringify({ name: "x", steps: [{ tool: bad, args: {} }] }),
      }), deps);
      expect(res.status).toBe(400);
    }
    // Nothing was persisted.
    expect((await (await H(req("GET", "/workflows", { bearer: s.token }), deps)).json()).items).toHaveLength(0);
  });

  it("POST with only allowlisted tools → 201", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("POST", "/workflows", {
      bearer: s.token,
      body: JSON.stringify({
        name: "ok",
        steps: [
          { tool: "file_message", args: {} },
          { tool: "draft_reply", args: {} },
          { tool: "add_kb_entry", args: {} },
        ],
      }),
    }), deps);
    expect(res.status).toBe(201);
  });
});

describe("workflows — run enqueue idempotency", () => {
  async function makeEnabledWorkflow(db: Db, deps: ApiDeps, token: string): Promise<string> {
    const created = await H(req("POST", "/workflows", {
      bearer: token, body: JSON.stringify({ name: "wf", enabled: true, trigger: { kind: "manual" } }),
    }), deps);
    return (await created.json()).id;
  }

  it("POST /run with an Idempotency-Key → 202 {runId} + a pending run; retry replays; a new key → a new run", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await makeEnabledWorkflow(db, deps, s.token);

    const first = await H(req("POST", `/workflows/${id}/run`, { bearer: s.token, headers: { "idempotency-key": "run-1" } }), deps);
    expect(first.status).toBe(202);
    const { runId } = await first.json();
    expect(runId).toBeTruthy();

    const runs1 = await runsFor(db, s.accountId);
    expect(runs1).toHaveLength(1);
    expect(runs1[0]!.status).toBe("pending");

    // Same key → verbatim replay: same runId, 202, NO second run row.
    const replay = await H(req("POST", `/workflows/${id}/run`, { bearer: s.token, headers: { "idempotency-key": "run-1" } }), deps);
    expect(replay.status).toBe(202);
    expect((await replay.json()).runId).toBe(runId);
    expect(await runsFor(db, s.accountId)).toHaveLength(1);

    // A DIFFERENT key → a brand-new run.
    const second = await H(req("POST", `/workflows/${id}/run`, { bearer: s.token, headers: { "idempotency-key": "run-2" } }), deps);
    expect(second.status).toBe(202);
    expect((await second.json()).runId).not.toBe(runId);
    expect(await runsFor(db, s.accountId)).toHaveLength(2);
  });

  it("a disabled workflow → 409; the run appears in GET /workflow-runs", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });

    // Disabled (default) → 409.
    const off = await H(req("POST", "/workflows", { bearer: s.token, body: JSON.stringify({ name: "off" }) }), deps);
    const offId = (await off.json()).id;
    expect((await H(req("POST", `/workflows/${offId}/run`, { bearer: s.token, headers: { "idempotency-key": "z" } }), deps)).status).toBe(409);

    // An enabled workflow's run shows in the runs feed.
    const id = await makeEnabledWorkflow(db, deps, s.token);
    const { runId } = await (await H(req("POST", `/workflows/${id}/run`, { bearer: s.token, headers: { "idempotency-key": "r" } }), deps)).json();
    const feed = await (await H(req("GET", "/workflow-runs", { bearer: s.token }), deps)).json();
    expect(feed.items.map((r: { id: string }) => r.id)).toContain(runId);
  });

  it("soft-deleting the workflow retains its run history", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await makeEnabledWorkflow(db, deps, s.token);
    const { runId } = await (await H(req("POST", `/workflows/${id}/run`, { bearer: s.token, headers: { "idempotency-key": "r" } }), deps)).json();

    expect((await H(req("DELETE", `/workflows/${id}`, { bearer: s.token }), deps)).status).toBe(204);
    // Workflow gone, but the run row survives.
    expect((await H(req("GET", `/workflows/${id}`, { bearer: s.token }), deps)).status).toBe(404);
    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(runs).toHaveLength(1);
  });
});

/**
 * the 202 was a promise the platform could not keep.
 *
 * In production the worker has no `config.drafter`, substitutes `unconfiguredDrafter`, and every
 * `draft_reply` step throws. The API nonetheless answered 202 with a `runId` and durably inserted
 * a `workflow_runs` row, so the user held a receipt for work already decided against and then saw
 * it fail as if a step had gone wrong. These drive the REFUSAL through the real router — status,
 * code, envelope field and the absence of both rows — because the point of the fix is what a
 * client receives, which a unit call on the service could not show.
 */
describe("workflows — draft_reply refused at ENQUEUE when no drafter is wired", () => {
  /** The same deps with the DraftPort removed — a rules-only deployment (no ANTHROPIC_API_KEY). */
  const withoutDrafter = (deps: ApiDeps): ApiDeps =>
    ({ ...deps, services: { ...deps.services!, drafter: undefined } });

  async function makeWorkflow(deps: ApiDeps, token: string, steps: unknown[]): Promise<string> {
    const created = await H(req("POST", "/workflows", {
      bearer: token,
      body: JSON.stringify({ name: "wf", enabled: true, trigger: { kind: "manual" }, steps }),
    }), deps);
    expect(created.status).toBe(201);
    return (await created.json()).id;
  }

  it("a draft_reply workflow → 503 drafter_unconfigured, retryable:false, and NO run row", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await makeWorkflow(deps, s.token, [
      { tool: "file_message", args: { messageId: "m1", toFolder: "ohmail/Done" } },
      { tool: "draft_reply", args: { messageId: "m1" } },
    ]);

    const res = await H(req("POST", `/workflows/${id}/run`, {
      bearer: s.token, headers: { "idempotency-key": "no-ai" },
    }), withoutDrafter(deps));

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("drafter_unconfigured");
    // Only an operator can clear this, so the client must NOT be told to retry. Without the
    // explicit flag `HttpAdapter.rejectionOf` would infer `retryable: true` from the 5xx.
    expect(body.error.retryable).toBe(false);

    // The whole point: nothing was durably recorded, so there is no receipt and no orphan run.
    expect(await runsFor(db, s.accountId)).toHaveLength(0);
    expect(await db.select().from(idempotencyKeys)
      .where(eq(idempotencyKeys.accountId, s.accountId))).toHaveLength(0);
  });

  it("a workflow with NO draft_reply step still enqueues → 202 (the refusal is scoped)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await makeWorkflow(deps, s.token, [
      { tool: "file_message", args: { messageId: "m1", toFolder: "ohmail/Done" } },
      { tool: "add_kb_entry", args: { title: "t", content: "c" } },
    ]);

    const res = await H(req("POST", `/workflows/${id}/run`, {
      bearer: s.token, headers: { "idempotency-key": "rules-only" },
    }), withoutDrafter(deps));
    expect(res.status).toBe(202);
    expect(await runsFor(db, s.accountId)).toHaveLength(1);
  });

  it("the SAME draft_reply workflow enqueues normally once a drafter IS wired → 202", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await makeWorkflow(deps, s.token, [{ tool: "draft_reply", args: { messageId: "m1" } }]);

    const res = await H(req("POST", `/workflows/${id}/run`, {
      bearer: s.token, headers: { "idempotency-key": "with-ai" },
    }), deps);   // makeDeps wires DEFAULT_MOCK_DRAFTER
    expect(res.status).toBe(202);
    expect(await runsFor(db, s.accountId)).toHaveLength(1);
  });

  it("a refusal poisons no Idempotency-Key: the same key succeeds after AI is connected", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const id = await makeWorkflow(deps, s.token, [{ tool: "draft_reply", args: { messageId: "m1" } }]);
    const key = { "idempotency-key": "same-key" };

    const refused = await H(req("POST", `/workflows/${id}/run`, { bearer: s.token, headers: key }),
      withoutDrafter(deps));
    expect(refused.status).toBe(503);

    // The refusal rolled its tx back, so no stored response exists to replay — the retry runs
    // for real rather than replaying a 503 for ever. This is the recovery path after go-live.
    const accepted = await H(req("POST", `/workflows/${id}/run`, { bearer: s.token, headers: key }), deps);
    expect(accepted.status).toBe(202);
    expect((await accepted.json()).runId).toBeTruthy();
    expect(await runsFor(db, s.accountId)).toHaveLength(1);
  });
});

describe("workflow-runs undo", () => {
  async function enqueueRun(db: Db, deps: ApiDeps, token: string): Promise<string> {
    const created = await H(req("POST", "/workflows", {
      bearer: token, body: JSON.stringify({ name: "wf", enabled: true, trigger: { kind: "manual" } }),
    }), deps);
    const id = (await created.json()).id;
    const run = await H(req("POST", `/workflows/${id}/run`, { bearer: token, headers: { "idempotency-key": "r" } }), deps);
    return (await run.json()).runId;
  }

  it("POST /workflow-runs/:id/undo → 200 + the run marked undone", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const runId = await enqueueRun(db, deps, s.token);

    const res = await H(req("POST", `/workflow-runs/${runId}/undo`, { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("undone");
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run!.status).toBe("undone");
  });

  it("cross-account undo → 404", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, token: "owner-tok" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });
    const runId = await enqueueRun(db, deps, owner.token);
    expect((await H(req("POST", `/workflow-runs/${runId}/undo`, { bearer: other.token }), deps)).status).toBe(404);
  });

  /**
   * through the route the press actually takes: a run the drain is
   * stepping through is refused with a code a client can switch on, not silently marked undone.
   */
  it("a run the workflow runner is stepping through → 409 run_in_flight", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const runId = await enqueueRun(db, deps, s.token);
    await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, runId));

    const res = await H(req("POST", `/workflow-runs/${runId}/undo`, { bearer: s.token }), deps);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("run_in_flight");
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run!.status).toBe("running");
  });
});

describe("workflows — REST-only + cross-account", () => {
  it("a created workflow + enqueued run emit NO change_log row", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const created = await H(req("POST", "/workflows", {
      bearer: s.token, body: JSON.stringify({ name: "wf", enabled: true }),
    }), deps);
    const id = (await created.json()).id;
    await H(req("POST", `/workflows/${id}/run`, { bearer: s.token, headers: { "idempotency-key": "r" } }), deps);
    const changes = await db.select().from(changeLog).where(eq(changeLog.accountId, s.accountId));
    expect(changes).toHaveLength(0);
  });

  it("cross-account get / patch / delete / run → 404", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW, token: "owner-tok" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "other-tok" });
    const created = await H(req("POST", "/workflows", {
      bearer: owner.token, body: JSON.stringify({ name: "wf", enabled: true }),
    }), deps);
    const id = (await created.json()).id;

    expect((await H(req("GET", `/workflows/${id}`, { bearer: other.token }), deps)).status).toBe(404);
    expect((await H(req("PATCH", `/workflows/${id}`, { bearer: other.token, body: JSON.stringify({ name: "x" }) }), deps)).status).toBe(404);
    expect((await H(req("POST", `/workflows/${id}/run`, { bearer: other.token, headers: { "idempotency-key": "x" } }), deps)).status).toBe(404);
    expect((await H(req("DELETE", `/workflows/${id}`, { bearer: other.token }), deps)).status).toBe(404);
    // Owner's workflow is intact.
    expect((await H(req("GET", `/workflows/${id}`, { bearer: owner.token }), deps)).status).toBe(200);
  });
});
