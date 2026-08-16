import { type Tx } from "@trafficflow/db";
import { getAiEnabled, setAiEnabled } from "@trafficflow/db/cloud";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { readBody } from "./shared.js";

/**
 * `GET/PATCH /account/ai`: **the off switch**, honoured server-side.
 *
 * The site promises "you can switch the AI off entirely without losing a single feature that
 * files your mail." These two endpoints are what makes that a property of the account rather
 * than of a checkbox: the flag lives on `accounts.ai_enabled` and is read by `spendState()` in
 * `packages/db/src/ai-gate.ts`, which every AI call site in the product passes through. So
 * turning it off here means — for the very next message — no model call, no credit debit, and
 * routing by the deterministic rules alone.
 *
 * ## Its own file, on purpose
 *
 * `account.ts` would have been the natural home. This is a separate module because another
 * workstream is editing `packages/api/src/routes` concurrently, and a new file reduces the
 * shared surface to a single import line in `routes/index.ts`.
 *
 * ## Why no step-up
 *
 * `DELETE /account` carries `stepUp: true` because it is irreversible. This is the opposite:
 * reversible by the same request with the opposite boolean, destroys nothing, and moves no
 * money. Requiring re-authentication to turn OFF a feature would also be backwards — the safe
 * direction must never be the harder one.
 */
export const aiSettingsRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/account/ai",
    cost: "read",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      return jsonResponse({ aiEnabled: await getAiEnabled(ctx.db as unknown as Tx, ctx.accountId) });
    },
  },
  {
    method: "PATCH",
    pattern: "/account/ai",
    cost: "work",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const body = await readBody<{ aiEnabled?: unknown }>(req);
      // A strict boolean, and no coercion. `"false"`, `0` and `null` are all truthy-or-falsy in
      // some reading, and guessing which one a client meant is how a customer ends up with the
      // setting they did not choose — on the one endpoint whose entire purpose is consent.
      if (typeof body.aiEnabled !== "boolean") {
        return jsonResponse(
          { error: "invalid_request", detail: "aiEnabled must be a boolean" },
          { status: 400 },
        );
      }
      const result = await setAiEnabled(
        ctx.db as unknown as Tx, ctx.accountId, body.aiEnabled,
        { userId: ctx.userId, requestId: ctx.requestId },
      );
      return jsonResponse(result);
    },
  },
];
