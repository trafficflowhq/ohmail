import { listWaitingOnOrganizer } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";

/**
 * `GET /organizer-requests` — what waits on the install that organizes a mailbox: this door's
 * requests still in flight, and those resolved within a day (a refusal with its reason). The one
 * source the Rules page and the phone's waiting sheet read; a mixed account's rule delete answers
 * 204 and is listed here (the 2026-09-07 condition). Read-only: no service write runs here.
 */
export const organizerRequestRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/organizer-requests",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const items = await listWaitingOnOrganizer(serviceContext(deps, req));
      return jsonResponse({ items });
    },
  },
];
