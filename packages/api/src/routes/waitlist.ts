import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { readBody } from "./shared.js";
import { waitlistSvc } from "./shared-cloud.js";

/**
 * `POST /waitlist` — the landing form's only server call. `{ public: true }` exactly: an ambient
 * enrollment cookie is dropped, not 403'd; not `raw` — the request guard demands JSON
 * `Content-Type`, killing the one shape a browser can POST cross-origin without a preflight; not
 * `idempotent` — an upsert on `email`, mail deduplicated downstream. Two rate-limit keys, two
 * victims: the recipient (the per-recipient limiter under the `unsolicited` quota) and us (per-IP
 * join slots, 429). The response is a constant `202 {status:"ok"}`: it used to carry `mailed`, a
 * limiter readout that leaked whether we had recently mailed a person. 202, not 201: the durable
 * effect is done, the visible one best-effort.
 */
export const waitlistRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/waitlist",
    relay: false,  /* the hosted marketing surface */
    cost: "unauthenticated",
    options: { public: true },
    handler: async (req, deps) => {
      // `unknown`, not `string` — this body is a JSON document a stranger wrote, and
      // `{"tier": 42}` used to reach `.trim()` and answer 500. `WaitlistService` does the
      // coercion (`asWireString`); the type here is what stops a future edit from
      // "helpfully" re-declaring these as strings.
      const body = await readBody<{ email?: unknown; tier?: unknown; source?: unknown }>(req);
      await waitlistSvc(deps).join(serviceContext(deps, req), {
        email: typeof body.email === "string" ? body.email : "",
        tier: body.tier,
        source: body.source,
      });
      // CONSTANT. Not `out` — see the header: `mailed` is a limiter readout and this is a
      // public endpoint. The service's return value stays inside the process.
      return jsonResponse({ status: "ok" }, { status: 202 });
    },
  },
];
