import {
  claimIdempotencyKey, IDEMPOTENCY_PENDING_BODY, IDEMPOTENCY_PENDING_STATUS,
  releasePendingIdempotencyKey, settleIdempotencyKey,
} from "@trafficflow/db";
import { withAccountTx, type ServiceContext } from "./context.js";
import type { DraftCreateIdempotency } from "./drafts-service.js";
import { IdempotencyRaceLost, type ServiceError } from "./errors.js";

export interface DraftReceipt {
  idempotency: DraftCreateIdempotency;
  fail(error: ServiceError): Promise<void>;
  abandon(): Promise<void>;
}

const DRAFT_PENDING_FALLBACK_MS = 15 * 60_000;
const DRAFT_PENDING_MARGIN_MS = 3_000;

/** Reserve the key beyond the request's lifetime so a retry can recover an interrupted purchase. */
export async function claimDraftReceipt(
  ctx: ServiceContext, idempotency: DraftCreateIdempotency, invocationBudgetMs?: number,
): Promise<DraftReceipt> {
  const ttlMs = (invocationBudgetMs ?? DRAFT_PENDING_FALLBACK_MS) + DRAFT_PENDING_MARGIN_MS;
  const scope = { accountId: ctx.accountId, key: idempotency.key, requestHash: idempotency.requestHash };
  const claimed = await withAccountTx(ctx, (tx) => claimIdempotencyKey(tx, {
    ...scope, responseStatus: IDEMPOTENCY_PENDING_STATUS, responseJson: IDEMPOTENCY_PENDING_BODY, seq: null, now: ctx.now(),
    ttlMs,
  }));
  if (!claimed) throw new IdempotencyRaceLost(scope.accountId, scope.key);

  let terminal = false;
  return {
    idempotency: { ...idempotency, pending: true },
    async fail(error) {
      // A failed receipt write leaves the key held until the pending claim expires.
      terminal = true;
      const { code, httpStatus, message, details, retryable } = error;
      const settled = await withAccountTx(ctx, (tx) => settleIdempotencyKey(tx, {
        ...scope, responseStatus: httpStatus, responseJson: { error: { code, message, details, retryable } },
        seq: null, now: ctx.now(),
      }));
      if (!settled) throw new IdempotencyRaceLost(scope.accountId, scope.key);
    },
    async abandon() {
      if (!terminal) await withAccountTx(ctx, (tx) => releasePendingIdempotencyKey(tx, scope));
    },
  };
}
