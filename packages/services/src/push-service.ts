import { and, eq } from "drizzle-orm";
import { claimIdempotencyKey, type Tx } from "@trafficflow/db";
import { pushSubscriptions } from "@trafficflow/db/cloud";
import type { ServiceContext } from "./context.js";
import { ServiceError, IdempotencyRaceLost } from "./errors.js";

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

/* THE SHAPES AND THE PORT live in `push-types.ts`; the implementation and the table it writes
 * live here. The vocabulary is shared because the routes that describe a registration are the same
 * code in a hosted deployment and a local install, while this table exists only in the hosted
 * journal. Re-exported so that no existing import of these names has to move. */
export type {
  PushTransport, PushSubscribeBody, PushIdempotency, PushSubscribeResult,
} from "./push-types.js";
import type {
  PushTransport, PushSubscribeBody, PushIdempotency, PushSubscribeResult,
  PushService as PushServicePort,
} from "./push-types.js";

/**
 * PushService — device-local push registrations. Subscriptions
 * are config, NOT client-visible entities: they emit NO `change_log`. `subscribe`
 * upserts, deduped at the DB level by the coalesced UNIQUE(account_id, transport,
 * COALESCE(endpoint, device_token)); a re-registration returns the existing id.
 * When an `Idempotency-Key` is present the idempotency row is written in the SAME
 * tx so a commit-then-crash retry replays verbatim. All scoped to
 * `ctx.accountId`.
 */
export class PushService implements PushServicePort {
  async subscribe(
    ctx: ServiceContext, body: PushSubscribeBody, opts: { idempotency?: PushIdempotency | null } = {},
  ): Promise<PushSubscribeResult> {
    const transport = body.transport;
    if (transport !== "webpush" && transport !== "apns") {
      throw new ServiceError("validation_failed", 400, "transport must be 'webpush' or 'apns'");
    }
    // Validate the transport-appropriate identity is present.
    if (transport === "webpush" && (!body.endpoint || !body.p256dh || !body.auth)) {
      throw new ServiceError("validation_failed", 400, "webpush requires endpoint, p256dh and auth");
    }
    if (transport === "apns" && !body.deviceToken) {
      throw new ServiceError("validation_failed", 400, "apns requires deviceToken");
    }

    const id = await asTx(ctx).transaction(async (tx) => {
      const inserted = await tx.insert(pushSubscriptions).values({
        accountId: ctx.accountId,
        transport,
        endpoint: body.endpoint ?? null,
        p256dh: body.p256dh ?? null,
        auth: body.auth ?? null,
        deviceToken: body.deviceToken ?? null,
        bundleId: body.bundleId ?? null,
        environment: body.environment ?? null,
        deviceId: body.deviceId ?? null,
      }).onConflictDoNothing().returning({ id: pushSubscriptions.id });

      // On conflict the coalesced unique index deduped the row → fetch the existing id.
      const rowId = inserted[0]?.id ?? (await this.existingId(tx, ctx.accountId, transport, body));

      // Store the verbatim response (201 { id }) in the SAME tx. Push emits no
      // change_log, so seq is null. On replay the middleware returns this untouched.
      // A LOST claim means a concurrent same-key request committed first → throw so this
      // subscription insert rolls back and the caller replays the winner's id.
      if (opts.idempotency) {
        const claimed = await claimIdempotencyKey(tx, {
          accountId: ctx.accountId,
          key: opts.idempotency.key,
          requestHash: opts.idempotency.requestHash,
          responseStatus: 201,
          responseJson: { id: rowId },
          seq: null,
          now: ctx.now(),
        });
        if (!claimed) throw new IdempotencyRaceLost(ctx.accountId, opts.idempotency.key);
      }

      return rowId;
    });

    return { id, transport };
  }

  async unsubscribe(ctx: ServiceContext, id: string): Promise<void> {
    const deleted = await asTx(ctx).delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.accountId, ctx.accountId)))
      .returning({ id: pushSubscriptions.id });
    if (deleted.length === 0) throw new ServiceError("not_found", 404, "subscription not found");
  }

  /** Resolve the id of the row the unique index deduped to (same account+transport+identity). */
  private async existingId(
    tx: Tx, accountId: string, transport: PushTransport, body: PushSubscribeBody,
  ): Promise<string> {
    const identity = transport === "webpush"
      ? eq(pushSubscriptions.endpoint, body.endpoint!)
      : eq(pushSubscriptions.deviceToken, body.deviceToken!);
    const [row] = await tx.select({ id: pushSubscriptions.id }).from(pushSubscriptions)
      .where(and(
        eq(pushSubscriptions.accountId, accountId),
        eq(pushSubscriptions.transport, transport),
        identity,
      )).limit(1);
    if (!row) throw new ServiceError("internal", 500, "push subscription vanished after upsert");
    return row.id;
  }
}

export const pushService = new PushService();
