import { clientIdempotencyKey } from "@trafficflow/db";
import { ServiceError } from "@trafficflow/services/mail";
import type { DraftFromTextBody, UntrustedBody } from "@ohmail/wire";
import { serviceContext } from "../context.js";
import { answer } from "../responses.js";
import type { Route } from "../router.js";
import { drafting, drafter, readBody, spendOf, accessPortOf, refundObligationsOf } from "./shared.js";

/**
 * `POST /drafts/from-text` — a draft written from the person's own words, beside a letter it
 * answers or in a mailbox they name. Draft reply's shape in every other respect: `paid`, the
 * `Idempotency-Key` required where it is metered (400 without, before anything is read), the
 * drafter asked for before the service (503 where none is composed), the stored draft's id
 * answered 202 with `X-Sync-Seq`, and a same-key retry answered from the stored 202. Never sent.
 */
export const draftFromTextRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/drafts/from-text",
    wire: true,
    relay: true,
    cost: "paid",
    options: { idempotent: true },
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const credits = spendOf(deps);
      if (credits && !deps.idempotency) {
        throw new ServiceError("idempotency_key_required", 400, "an Idempotency-Key header is required for AI drafting");
      }
      const port = drafter(deps);
      const body = await readBody<UntrustedBody<DraftFromTextBody>>(req);
      const { draftId, seq } = await drafting(deps).draftFromText(ctx, body, {
        drafter: port,
        onPreview: deps.onDraftPreview,
        credits,
        ...(refundObligationsOf(deps) ? { obligations: refundObligationsOf(deps)! } : {}),
        ...(accessPortOf(deps) ? { access: accessPortOf(deps)! } : {}),
        attemptKey: deps.idempotency ? clientIdempotencyKey(deps.idempotency.key) : undefined,
        idempotency: deps.idempotency
          ? {
              key: deps.idempotency.key,
              requestHash: deps.idempotency.requestHash,
              responseStatus: 202,
              response: (r) => ({ draftId: r.draftId }),
            }
          : undefined,
      });
      return answer<"POST /drafts/from-text">()({ draftId }, { status: 202, seq });
    },
  },
];
