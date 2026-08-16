import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { proposals } from "./shared-cloud.js";

/**
 * AI-PROPOSED WORKFLOWS — the two routes that read the proposer's output.
 *
 * They sat in `workflows.js` beside the CRUD, and they are the only part of that file which needs
 * a proposer. The proposer calls a model, so it is not part of the mail half and is not present in
 * a local install at all: the two routes could only ever have answered "not configured" there,
 * while making the module that carries the whole workflow CRUD depend on a service it must not
 * name.
 *
 * Splitting them costs a local host nothing it had — a route it never served now returns 404
 * instead of a 500 that said the service was missing, which is the more honest of the two answers
 * for a surface this deployment genuinely does not offer.
 *
 * Proposals are INERT by construction: listing and dismissing are all that is here. A proposal
 * becomes a workflow only through the ordinary create path, disabled, with the user acting.
 */
export const proposalsRoutes: Route[] = [
  {
    // AI-proposed workflows (INERT until POST /workflows {fromProposalId}). The
    // worker cron generates them via the injected Opus port; here we only list the OPEN
    // ones. Static `/workflows/proposals` out-specifies `/workflows/:id`.
    method: "GET",
    pattern: "/workflows/proposals",
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
    cost: "work",
    handler: async (req, deps, params) => {
      await proposals(deps).dismiss(serviceContext(deps, req), params.id!);
      return new Response(null, { status: 204 });
    },
  },
];
