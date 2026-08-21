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
   * `endpointGuard` is the deployment's UnifiedPush endpoint policy
   * (`@trafficflow/core/net`'s {@link PushEndpointGuard}) and it is OPTIONAL for one reason and
   * one only: an ABSENT guard REFUSES every `unifiedpush` registration. That is the safe
   * direction and it is what lets {@link pushService} keep being a plain singleton for the
   * webpush/apns callers that predate this, instead of a security-relevant argument every one of
   * them would have had to be edited to pass. A host that wants wake registrations wires the
   * guard through {@link makePushService} and says so; a host that forgets gets 400 at
   * registration, which is visible, rather than an unvalidated endpoint in the table, which is
   * not.
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
     * ── UNIFIEDPUSH: THE ENDPOINT GOES THROUGH THE SSRF GATE HERE **AND** AT SEND TIME ────────
     *
     * BOTH, and neither is redundant:
     *
     *  · HERE, because a row that was never cleared is a row a background process will dial. The
     *    refusal a person can act on is the one that comes back from the request they made, not a
     *    silent skip in a worker log hours later — and refusing at the door means the table never
     *    holds an endpoint pointing at `169.254.169.254` in the first place.
     *  · AT SEND TIME (`apps/worker/src/push-wake.ts`), because this clearance expires the moment
     *    the name re-resolves. A registration validated in January is dialled in March, and the
     *    same host can answer differently. Clearing once and trusting the row forever is the
     *    time-of-check/time-of-use hole with extra steps.
     *
     * The guard is the deployment's policy, not this file's (`@trafficflow/core/net`): strict on
     * the managed host, relaxed only under an operator's explicit `TF_PUSH_ALLOW_PRIVATE=1`. Its
     * return value — the pin — is discarded here on purpose: we are not dialling anything, and a
     * pin that will be minutes or months stale by send time is worth nothing to store.
     *
     * KEYS ARE OPTIONAL AND STORED WHEN OFFERED, which is a correction to an earlier reading of
     * this transport as "endpoint, no keys, ever". UnifiedPush 3.x endpoints are Web Push
     * endpoints, and a UP connector hands the app `{ url, pubKey, auth }` — the exact three
     * columns `webpush` already uses. The wake this repo sends today is the UNENCRYPTED constant,
     * so the keys are not read by anything yet; accepting them costs one line and means the
     * encrypting arm needs no migration and no re-registration on every device. Nothing here
     * claims they are used — see `apps/worker/src/push-wake.ts` for what actually goes on the wire.
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
      if (transport === "unifiedpush" && ctx.sessionId) {
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
       * ── A DEDUPED RE-REGISTRATION MUST RE-STAMP THE DEVICE, OR THE REVOKE LOSES ITS HANDLE ────
       *
       * `onConflictDoNothing` above is right about the ROW — one endpoint, one registration — and
       * it was wrong about the device, which is a hole in the take-back rather than a tidiness
       * point. A UnifiedPush endpoint is stable for the life of an app install, so the second
       * registration of the same endpoint is the ORDINARY case: the phone was revoked and paired
       * again, or simply relaunched after a re-pair. The distributor hands back the same URL, the
       * insert conflicts, and the row keeps pointing at the OLD device id — a device row that a
       * revoke has already removed. From then on nothing can take that registration down: the
       * current device's revoke does not match it, and the old device's revoke has already
       * happened. The endpoint keeps receiving wakes with no surface that can stop it.
       *
       * So the stamp is refreshed, in the same transaction, scoped to the row and the account. The
       * keys travel with it for the same reason — a re-registration is the connector's latest word
       * on both, and a stale `p256dh` beside a fresh endpoint is a registration that could not be
       * encrypted to even once there is something to encrypt.
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
