import { type Tx } from "@trafficflow/db";
import { getAiAnswer, setAiEnabled } from "@trafficflow/db/cloud";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { readBody } from "./shared.js";

/**
 * `GET/PATCH /account/ai`: the off switch, honoured server-side. The site promises the AI can be
 * switched off entirely without losing a feature that files mail; these endpoints make that a
 * property of the account: the flag lives on `accounts.ai_enabled` and is read by the one seam
 * every AI call site passes before it spends — off means, for the very next message, no model
 * call, no credit debit, routing by the deterministic rules alone. Its own file so concurrent
 * route work shares only an import line. No step-up: reversible by the same request with the
 * opposite boolean, destroys nothing, moves no money — and the safe direction must never be the
 * harder one.
 */
export const aiSettingsRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/account/ai",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      /* BOTH FACTS, because one cannot answer the onboarding question. `aiEnabled` says whether
         AI is on; `aiAnswered` says whether anybody was ever asked, which its resting value
         (`true`) cannot distinguish from a "yes". The first-run posture is a four-state union for
         exactly that reason — see migration 0084. `aiEnabled` keeps its name and meaning, so the
         Settings switch that has always read this route is unaffected. */
      const ai = await getAiAnswer(ctx.db as unknown as Tx, ctx.accountId);
      return jsonResponse({ aiEnabled: ai.enabled, aiAnswered: ai.answered });
    },
  },
  {
    method: "PATCH",
    pattern: "/account/ai",
    relay: true,
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
      /* `aiAnswered: true` UNCONDITIONALLY, and it is a fact rather than an optimism: reaching
         this line means the stamp was written, whether or not the switch moved (`setAiEnabled`
         records the answer either way — the first-run "Yes" is usually a write of the value the
         account already had). Echoing it lets the client re-derive its posture with no second
         round trip, on the same answer the next GET would give. */
      return jsonResponse({ ...result, aiAnswered: true });
    },
  },
];
