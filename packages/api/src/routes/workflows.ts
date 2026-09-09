import type { CreateWorkflowBody, PatchWorkflowBody } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { workflows, readBody } from "./shared.js";

/**
 * §5.10 — Workflows. Account-scoped CRUD over `workflows` + the run ENQUEUE, all
 * REST-only: no `X-Sync-Seq`/change_log, so clients refetch.
 *
 * `POST /workflows` validates the tool ALLOWLIST: a step declaring `send`/`forward`
 * (anything outside file_message/draft_reply/add_kb_entry) → 400. `DELETE` is a
 * SOFT-delete → 204; the workflow leaves list/get (404) but its `workflow_runs`
 * history is retained. `POST /workflows/:id/run` is idempotent-marked: the service
 * writes the `idempotency_keys` row IN its enqueue tx, so a retried Idempotency-Key
 * replays the same `{ runId }` (202) and never double-enqueues; a disabled workflow
 * → 409. All account-scoped (404 cross-account/deleted). Enqueue is all this
 * layer does — the runner that drains `pending` runs is not part of it.
 */
export const workflowsRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/workflows",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const items = await workflows(deps).list(serviceContext(deps, req));
      return jsonResponse({ items });
    },
  },
  {
    method: "POST",
    pattern: "/workflows",
    relay: true,
    cost: "work",
    handler: async (req, deps) => {
      const body = await readBody<CreateWorkflowBody>(req);
      const dto = await workflows(deps).create(serviceContext(deps, req), body);
      return jsonResponse(dto, { status: 201 });
    },
  },
  {
    method: "GET",
    pattern: "/workflows/:id",
    relay: true,
    cost: "read",
    handler: async (req, deps, params) => {
      const dto = await workflows(deps).get(serviceContext(deps, req), params.id!);
      return jsonResponse(dto);
    },
  },
  {
    method: "PATCH",
    pattern: "/workflows/:id",
    relay: true,
    cost: "work",
    handler: async (req, deps, params) => {
      const patch = await readBody<PatchWorkflowBody>(req);
      const dto = await workflows(deps).update(serviceContext(deps, req), params.id!, patch);
      return jsonResponse(dto, { status: 200 });
    },
  },
  {
    method: "DELETE",
    pattern: "/workflows/:id",
    relay: true,
    cost: "work",
    handler: async (req, deps, params) => {
      await workflows(deps).softDelete(serviceContext(deps, req), params.id!);
      return new Response(null, { status: 204 });
    },
  },
  {
    // Idempotent-marked — the service writes the `idempotency_keys` row inside the
    // same tx as the `workflow_runs` insert, so `deps.idempotency` is threaded in.
    method: "POST",
    pattern: "/workflows/:id/run",
    relay: true,
    cost: "work",
    options: { idempotent: true },
    handler: async (req, deps, params) => {
      const { runId } = await workflows(deps).enqueueRun(serviceContext(deps, req), params.id!, {
        idempotency: deps.idempotency ?? null,
        // The capability this host can actually offer, so the service can refuse a
        // `draft_reply` workflow with `503 drafter_unconfigured` INSTEAD of answering 202 for
        // work the drain would only ever fail. `services.drafter` is present iff the host that
        // built this dependency bag validated an AI API key, which is a proxy for the WORKER's
        // env rather than a reading of it — see `assertRunnable` for what that does and does
        // not prove. Passing it explicitly rather than letting the service default matters: the
        // default is permissive, so a route that forgot this line would silently go back to
        // handing out 202s.
        drafterConfigured: deps.services?.drafter != null,
      });
      return jsonResponse({ runId }, { status: 202 });
    },
  },
  {
    // One-click undo. Replays this run's `audit_log` inverses in reverse order,
    // each guarded on current state, then marks the run `undone`. Cross-account → 404.
    method: "POST",
    pattern: "/workflow-runs/:id/undo",
    relay: true,
    cost: "work",
    handler: async (req, deps, params) => {
      const dto = await workflows(deps).undoRun(serviceContext(deps, req), params.id!);
      return jsonResponse(dto, { status: 200 });
    },
  },
  {
    method: "GET",
    pattern: "/workflow-runs",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const url = new URL(req.url);
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw != null ? Number(limitRaw) : undefined;
      const status = url.searchParams.get("status") ?? undefined;
      const workflowId = url.searchParams.get("workflowId") ?? undefined;
      const page = await workflows(deps).listRuns(serviceContext(deps, req), { cursor, limit, status, workflowId });
      return jsonResponse({ items: page.items, nextCursor: page.nextCursor });
    },
  },
];
