import { and, eq } from "drizzle-orm";
import { claimIdempotencyKey, sessions, type Tx } from "@trafficflow/db";
import { pushSubscriptions } from "@trafficflow/db/cloud";
import { SsrfRefusal, type PushEndpointGuard } from "@trafficflow/core/net";
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
  /**
   * `endpointGuard` is the deployment's UnifiedPush endpoint policy (`@trafficflow/core/net`'s
   * `PushEndpointGuard`), OPTIONAL for one reason only: an ABSENT guard REFUSES every
   * `unifiedpush` registration. The safe direction — it lets `pushService` stay a plain singleton
   * for the webpush/apns callers that predate this instead of a security-relevant argument each
   * would have to pass. A host that wants wake registrations wires the guard through
   * `makePushService`; one that forgets gets 400 at registration, which is visible, rather than
   * an unvalidated endpoint in the table, which is not.
   */
  constructor(private readonly deps: { endpointGuard?: PushEndpointGuard } = {}) {}

  async subscribe(
    ctx: ServiceContext, body: PushSubscribeBody, opts: { idempotency?: PushIdempotency | null } = {},
  ): Promise<PushSubscribeResult> {
    const transport = body.transport;
    if (transport !== "webpush" && transport !== "apns" && transport !== "unifiedpush") {
      throw new ServiceError("validation_failed", 400, "transport must be 'webpush', 'apns' or 'unifiedpush'");
    }
    // Validate the transport-appropriate identity is present.
    if (transport === "webpush" && (!body.endpoint || !body.p256dh || !body.auth)) {
      throw new ServiceError("validation_failed", 400, "webpush requires endpoint, p256dh and auth");
    }
    if (transport === "apns" && !body.deviceToken) {
      throw new ServiceError("validation_failed", 400, "apns requires deviceToken");
    }
    /**
     * UNIFIEDPUSH: THE ENDPOINT PASSES THE SSRF GATE HERE AND AT SEND TIME. HERE, because an
     * uncleared row is one a background process will dial; the table never holds
     * `169.254.169.254`. AT SEND TIME (`apps/worker/src/push-wake.ts`), because clearance expires
     * when the name re-resolves — validate-once is TOCTOU with extra steps. The guard is the
     * deployment's policy (relaxed only under `TF_PUSH_ALLOW_PRIVATE=1`); its pin is discarded —
     * nothing is dialled here. KEYS ARE STORED WHEN OFFERED: UP 3.x endpoints are Web Push
     * endpoints, the wake today is the unencrypted constant, and keys now spare the encrypting
     * arm a re-registration.
     */
    if (transport === "unifiedpush") {
      if (!body.endpoint) throw new ServiceError("validation_failed", 400, "unifiedpush requires endpoint");
      const guard = this.deps.endpointGuard;
      if (!guard) {
        // Absent policy REFUSES. See the constructor: this is the branch a host that never wired
        // the guard lands in, and it must not be the branch that stores an unvalidated endpoint.
        throw new ServiceError("validation_failed", 400, "unifiedpush is not enabled on this server");
      }
      try {
        await guard.check(body.endpoint);
      } catch (err) {
        if (err instanceof SsrfRefusal) {
          throw new ServiceError("validation_failed", 400, `endpoint is not a permitted url: ${err.why}`);
        }
        throw err;
      }
    }

    const id = await asTx(ctx).transaction(async (tx) => {
      // The DEVICE the registration belongs to, resolved from the CALLER'S OWN session rather
      // than trusted from the body: a paired phone's bearer session carries its `device_id`, and
      // stamping it here is what lets `DELETE /devices/:id` (the webapp's revoke) take the wake
      // registration down with the credential. The body's `deviceId` stays honored for the
      // transports that already used it; the session wins when it names a device.
      let deviceId = body.deviceId ?? null;
      /**
       * `webpush` JOINED THIS, AND IT HAD TO: the sign-out and device-revoke prunes are
       * DEVICE-SCOPED, so a null `device_id` leaves a signed-out browser's registration live and
       * still woken. FOR A BROWSER THE STAMP IS A NO-OP: `AUTO_MINT_DEVICE_LABELS` covers the
       * four DESKTOP kinds only, so a browser session's `device_id` is null
       * (`auth-service.test.ts` asserts it); what the stamp reaches is `unifiedpush`. A BROWSER'S
       * ROW IS CLOSED FROM THE CLIENT — only the client can name it — via `DELETE
       * /push/subscriptions/:id` BEFORE `auth.logout()`; `logout-push-prune.pg.test.ts` holds
       * both halves. `apns` stays out: its identity is the device token.
       */
      if ((transport === "unifiedpush" || transport === "webpush") && ctx.sessionId) {
        const [s] = await tx.select({ deviceId: sessions.deviceId }).from(sessions)
          .where(eq(sessions.id, ctx.sessionId)).limit(1);
        if (s?.deviceId) deviceId = s.deviceId;
      }

      const inserted = await tx.insert(pushSubscriptions).values({
        accountId: ctx.accountId,
        transport,
        endpoint: body.endpoint ?? null,
        p256dh: body.p256dh ?? null,
        auth: body.auth ?? null,
        deviceToken: body.deviceToken ?? null,
        bundleId: body.bundleId ?? null,
        environment: body.environment ?? null,
        deviceId,
      }).onConflictDoNothing().returning({ id: pushSubscriptions.id });

      // On conflict the coalesced unique index deduped the row → fetch the existing id.
      const rowId = inserted[0]?.id ?? (await this.existingId(tx, ctx.accountId, transport, body));

      /**
       * A DEDUPED RE-REGISTRATION MUST RE-STAMP THE DEVICE, OR THE REVOKE LOSES ITS HANDLE.
       * `onConflictDoNothing` is right about the ROW and was wrong about the device: a
       * UnifiedPush endpoint is stable for the life of an install, so re-registering the same
       * endpoint is the ORDINARY case (revoked and paired again). The insert conflicts, the row
       * keeps the OLD device id — one a revoke already removed — and nothing can take the
       * registration down: it keeps receiving wakes with no surface to stop it. So the stamp is
       * refreshed in the same transaction, scoped to row and account; the keys travel with it — a
       * re-registration is the connector's latest word on both.
       */
      if (transport === "unifiedpush" && inserted[0] === undefined) {
        await tx.update(pushSubscriptions).set({
          deviceId,
          p256dh: body.p256dh ?? null,
          auth: body.auth ?? null,
        }).where(and(
          eq(pushSubscriptions.id, rowId),
          eq(pushSubscriptions.accountId, ctx.accountId),
        ));
      }

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
    const identity = transport === "apns"
      ? eq(pushSubscriptions.deviceToken, body.deviceToken!)
      : eq(pushSubscriptions.endpoint, body.endpoint!);   // webpush and unifiedpush both key on the endpoint
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

/**
 * The webpush/apns singleton, unchanged — and it refuses `unifiedpush`, by construction rather
 * than by accident (see the constructor). Kept because every existing composition root and test
 * harness names it, and because "the guard was never wired" and "wake registrations are off" are
 * the same fact, so there is nothing to distinguish.
 */
export const pushService = new PushService();

/**
 * The hosted composition roots' entry: a PushService that accepts UnifiedPush registrations,
 * because it was handed the deployment's endpoint policy. Called from `apps/api-vercel/src/deps.ts`
 * and `apps/server/src/deps.ts`; nothing else should construct one.
 */
export function makePushService(deps: { endpointGuard: PushEndpointGuard }): PushService {
  return new PushService(deps);
}
