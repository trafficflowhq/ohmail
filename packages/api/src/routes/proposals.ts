import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { proposals } from "./shared-cloud.js";

/**
 * AI-proposed workflows — the two routes that read the proposer's output. They sat beside the
 * workflow CRUD and are the only part of that file needing a proposer, which calls a model and is
 * not part of the mail half: on a local install the routes could only ever answer "not
 * configured" while making the CRUD module depend on a service it must not name. Splitting costs
 * a local host nothing it had — a route it never served now returns 404 instead of a 500, the
 * more honest answer for a surface this deployment does not offer. Proposals are inert by
 * construction: listing and dismissing are all that is here; a proposal becomes a workflow only
 * through the ordinary create path, disabled, with the user acting.
 */
export const proposalsRoutes: Route[] = [
  {
    // AI-proposed workflows (INERT until POST /workflows {fromProposalId}). The
    // worker cron generates them via the injected Opus port; here we only list the OPEN
    // ones. Static `/workflows/proposals` out-specifies `/workflows/:id`.
    method: "GET",
    pattern: "/workflows/proposals",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const items = await proposals(deps).list(serviceContext(deps, req));
      return jsonResponse({ items });
    },
  },
  {
    // 4b — dismiss an AI proposal (mark 'dismissed'; cross-account/unknown → 404).
    method: "POST",
    pattern: "/workflows/proposals/:id/dismiss",
    relay: true,
    cost: "work",
    handler: async (req, deps, params) => {
      await proposals(deps).dismiss(serviceContext(deps, req), params.id!);
      return new Response(null, { status: 204 });
    },
  },
];
