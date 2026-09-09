import type { ApprovalDecisionBody, ListApprovalsOptions } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { approval, readBody } from "./shared.js";

/**
 * §5.4 — approvals. `GET /approvals?status=pending` lists the queue. `POST
 * /approvals/:id` decides approve/reject: approve writes DESIRED folder_state
 * (`pending`) + emits a move change; both outcomes feed the learning loop; an
 * already-resolved/expired approval is a 422. It is idempotent (Idempotency-Key):
 * the service writes the idempotency row IN its decide tx, so a replay
 * returns the stored 200 (never re-deciding into a 422). NO IMAP here: the API
 * constructs the service WITHOUT an adapter — the physical move DEFERS to the
 * worker.
 */
export const approvalRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/approvals",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const url = new URL(req.url);
      const status = url.searchParams.get("status") ?? undefined;
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw != null ? Number(limitRaw) : undefined;
      const page = await approval(deps).list(serviceContext(deps, req), {
        status: status as ListApprovalsOptions["status"],
        cursor,
        limit,
      });
      return jsonResponse({ items: page.items, nextCursor: page.nextCursor });
    },
  },
  {
    method: "POST",
    pattern: "/approvals/:id",
    relay: true,
    cost: "work",
    options: { idempotent: true },
    handler: async (req, deps, params) => {
      const body = await readBody<ApprovalDecisionBody>(req);
      const dto = await approval(deps).decide(serviceContext(deps, req), params.id!, body, {
        idempotency: deps.idempotency ?? null,
      });
      return jsonResponse(dto);
    },
  },
];
