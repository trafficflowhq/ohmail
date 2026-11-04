import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { claimIdempotencyKey, sessions, type Tx } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { pushSubscriptions } from "@trafficflow/db/cloud";
import { SsrfRefusal, type PushEndpointGuard } from "@trafficflow/core/net";
import { bridgeTx, withAccountTx, type ServiceContext } from "./context.js";
import { ServiceError, IdempotencyRaceLost } from "./errors.js";

const asTx = (ctx: ServiceContext): Tx => bridgeTx(ctx.db);

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
 * COALESCE(endpoint, device_token)); a re-registration returns the existing id. Each row names
 * the session family that registered it, and every revoke deletes the rows of the families it
 * ends ({@link pruneWakeRows}). When an `Idempotency-Key` is present the idempotency row is
 * written in the SAME tx so a commit-then-crash retry replays verbatim. All scoped to
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

    const id = await withAccountTx(ctx, async (tx) => {
      // The DEVICE the registration belongs to, resolved from the CALLER'S OWN session rather
      // than trusted from the body: a paired phone's bearer session carries its `device_id`, and
      // stamping it here is what lets `DELETE /devices/:id` (the webapp's revoke) take the wake
      // registration down with the credential. The body's `deviceId` stays honored for the
      // transports that already used it; the session wins when it names a device.
      let deviceId = body.deviceId ?? null;
      /**
       * AND THE SESSION FAMILY, for every transport (cloud 0056). A browser session names no device
       * (`AUTO_MINT_DEVICE_LABELS` covers the desktop kinds only), so the device stamp left a
       * browser's row out of every revoke; the family is what every revoke ends, and each one
       * deletes the rows of its families ({@link pruneWakeRows}). The session is read live and
       * FOR SHARE, held to commit: a revoke that claims it waits for this row and then deletes
       * it, and a registration that waits for a revoke is refused. `apns` keeps the body's device:
       * its identity is the device token. No session (the worker's own tests) leaves the row unbound.
       */
      let familyId: string | null = null;
      if (ctx.sessionId) {
        const [s] = await dialect(tx).forUpdate(tx.select({ deviceId: sessions.deviceId, familyId: sessions.familyId })
          .from(sessions)
          .where(and(eq(sessions.id, ctx.sessionId), eq(sessions.accountId, ctx.accountId), isNull(sessions.revokedAt)))
          .limit(1), { mode: "share" });
        if (!s) throw new ServiceError("unauthorized", 401, "no active session");
        familyId = s.familyId;
        if ((transport === "unifiedpush" || transport === "webpush") && s.deviceId) deviceId = s.deviceId;
      }

      const insert = async (): Promise<string | undefined> => (await tx.insert(pushSubscriptions).values({
        accountId: ctx.accountId,
        transport,
        endpoint: body.endpoint ?? null,
        p256dh: body.p256dh ?? null,
        auth: body.auth ?? null,
        deviceToken: body.deviceToken ?? null,
        bundleId: body.bundleId ?? null,
        environment: body.environment ?? null,
        deviceId,
        sessionFamilyId: familyId,
      }).onConflictDoNothing().returning({ id: pushSubscriptions.id }))[0]?.id;

      // On conflict the coalesced unique index deduped the row: it is re-stamped, or, when a prune
      // took it in between, inserted afresh.
      const rowId = await insert() ?? await this.restamp(tx, ctx.accountId, transport, body, deviceId, familyId)
        ?? await insert();
      if (rowId === undefined) throw new ServiceError("internal", 500, "push subscription vanished after upsert");

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

  /**
   * RE-STAMP the row the unique index deduped to (same account+transport+identity), or `undefined`
   * when no such row is left. THE LATEST REGISTERING SESSION OWNS IT: a browser keeps one endpoint
   * across sign-ins, and a row left on an older family would follow that family's revoke instead of
   * the live session's. The write is skipped when nothing changes.
   *
   * UNIFIEDPUSH ALSO RE-STAMPS THE DEVICE AND THE KEYS: an endpoint is stable for the life of an
   * install, so re-registering it is the ordinary case (revoked and paired again), and a row left on
   * the old device id is one no revoke can take down. The keys travel with it — a re-registration is
   * the connector's latest word on both.
   */
  private async restamp(
    tx: Tx, accountId: string, transport: PushTransport, body: PushSubscribeBody,
    deviceId: string | null, familyId: string | null,
  ): Promise<string | undefined> {
    const identity = transport === "apns"
      ? eq(pushSubscriptions.deviceToken, body.deviceToken!)
      : eq(pushSubscriptions.endpoint, body.endpoint!);   // webpush and unifiedpush both key on the endpoint
    const [row] = await tx.select({ id: pushSubscriptions.id, familyId: pushSubscriptions.sessionFamilyId })
      .from(pushSubscriptions)
      .where(and(
        eq(pushSubscriptions.accountId, accountId),
        eq(pushSubscriptions.transport, transport),
        identity,
      )).limit(1);
    if (!row) return undefined;
    const set = {
      ...(transport === "unifiedpush" ? { deviceId, p256dh: body.p256dh ?? null, auth: body.auth ?? null } : {}),
      ...(familyId !== null && familyId !== row.familyId ? { sessionFamilyId: familyId } : {}),
    };
    if (Object.keys(set).length === 0) return row.id;
    const [kept] = await tx.update(pushSubscriptions).set(set)
      .where(and(eq(pushSubscriptions.id, row.id), eq(pushSubscriptions.accountId, accountId)))
      .returning({ id: pushSubscriptions.id });
    return kept?.id;
  }
}

/** Families one pair of prune statements takes. */
const PRUNE_FAMILIES = 500;

/** `pred`'s rows that no other transaction holds, as the id list one DELETE takes. */
const unheld = (pred: SQL): SQL => sql`${pushSubscriptions.id} = any(array(select ${pushSubscriptions.id}
  from ${pushSubscriptions} where ${pred} for update of ${pushSubscriptions} skip locked))`;

/**
 * THE WAKE ROWS OF THESE SESSION FAMILIES, deleted: the rows each family registered, and the rows of
 * the devices its sessions name, each in that session's own account (a family id under another
 * account names nothing of this one). Two statements per 500 families. A row another transaction
 * holds is passed over (SKIP LOCKED), so no revoke ever waits on a push row: an erasure deletes an
 * account's rows before it takes its sessions, and a revoke holding those sessions must not wait on
 * it. A row with neither binding is never touched.
 */
export async function pruneWakeRows(db: Tx, familyIds: readonly string[]): Promise<void> {
  const families = [...new Set(familyIds)];
  for (let i = 0; i < families.length; i += PRUNE_FAMILIES) {
    const chunk = families.slice(i, i + PRUNE_FAMILIES);
    const registered = db.select({ familyId: sessions.familyId, accountId: sessions.accountId })
      .from(sessions).where(inArray(sessions.familyId, chunk));
    await db.delete(pushSubscriptions).where(unheld(
      sql`(${pushSubscriptions.sessionFamilyId}, ${pushSubscriptions.accountId}) in ${registered}`));
    const named = db.select({ deviceId: sessions.deviceId, accountId: sessions.accountId })
      .from(sessions).where(and(inArray(sessions.familyId, chunk), isNotNull(sessions.deviceId)));
    await db.delete(pushSubscriptions).where(unheld(
      sql`(${pushSubscriptions.deviceId}, ${pushSubscriptions.accountId}) in ${named}`));
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
