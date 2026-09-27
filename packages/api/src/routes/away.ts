import { readProfileChange, type AwayResponderBody } from "@trafficflow/services/mail";
import type { Tx } from "@trafficflow/db";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { away, readBody } from "./shared.js";

/**
 * §5.16 — away / autoresponder (2 endpoints). GET returns the single per-account
 * row or a default disabled shape; PUT upserts it (full replace). `startsAt` must
 * be ≤ `endsAt` when both are set → else 400. REST-only, account-scoped.
 */
/** On a reader, where this install's last away change went — the row says a refusal with it. */
async function changeOf(ctx: ReturnType<typeof serviceContext>): Promise<{ change?: object }> {
  const { change } = await readProfileChange(ctx.db as unknown as Tx, ctx.accountId, "awayResponder", ctx.now());
  return change === null ? {} : { change };
}

export const awayRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/away-responder",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const dto = await away(deps).get(ctx);
      return jsonResponse({ ...dto, ...(await changeOf(ctx)) });
    },
  },
  {
    method: "PUT",
    pattern: "/away-responder",
    relay: true,
    cost: "work",
    replay: "state",
    handler: async (req, deps) => {
      const body = await readBody<AwayResponderBody>(req);
      const ctx = serviceContext(deps, req);
      const result = await away(deps).put(ctx, body);
      // 202 when the edit wrote nothing here and is waiting on the installs that organize this
      // account's mailboxes (mail 0094) — the Screener route's rule. `travel` rides BESIDE the
      // responder on a mixed account, so an ordinary one-install answer is unchanged byte for byte.
      if (result.pending) {
        return jsonResponse(
          { ...result.responder, pending: true, travel: result.travel, ...(await changeOf(ctx)) },
          { status: 202 },
        );
      }
      return jsonResponse(
        result.travel === undefined ? result.responder : { ...result.responder, travel: result.travel },
      );
    },
  },
];
