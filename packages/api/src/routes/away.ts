import type { AwayResponderBody } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { away, readBody } from "./shared.js";

/**
 * §5.16 — away / autoresponder (2 endpoints). GET returns the single per-account
 * row or a default disabled shape; PUT upserts it (full replace). `startsAt` must
 * be ≤ `endsAt` when both are set → else 400. REST-only, account-scoped.
 */
export const awayRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/away-responder",
    cost: "read",
    handler: async (req, deps) => {
      const dto = await away(deps).get(serviceContext(deps, req));
      return jsonResponse(dto);
    },
  },
  {
    method: "PUT",
    pattern: "/away-responder",
    cost: "work",
    handler: async (req, deps) => {
      const body = await readBody<AwayResponderBody>(req);
      const dto = await away(deps).put(serviceContext(deps, req), body);
      return jsonResponse(dto);
    },
  },
];
