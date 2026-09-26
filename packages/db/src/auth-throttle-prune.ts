import { and, isNull, like, lt, lte, not, or } from "drizzle-orm";
import { authThrottle } from "./schema-cloud.js";
import type { Tx } from "./change-log.js";

/**
 * HOW LONG A THROTTLE ROW OUTLIVES ITS WINDOW. One constant, never a policy re-derived here: the
 * longest window plus lockout any writer uses (the pre-session factor cap, 24 h + 24 h) must fit
 * under it, and `auth-throttle-retention.test.ts` pins every writer's policy against it.
 */
export const AUTH_THROTTLE_RETENTION_MS = 48 * 60 * 60 * 1000;

/** A client that completed a sign-in stays known this long after its last one. */
export const KNOWN_CLIENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Delete throttle rows past retention that hold no live lock — every prefix, including the typed
 * addresses stored in the clear before the keys were hashed. Run from the worker's maintenance
 * pass; nothing else deletes these rows but an account's erasure.
 */
export async function pruneAuthThrottle(tx: Tx, now: Date): Promise<number> {
  const known = like(authThrottle.key, "known:%");
  const gone = await tx.delete(authThrottle).where(and(
    or(isNull(authThrottle.lockedUntil), lte(authThrottle.lockedUntil, now)),
    or(
      and(not(known), lt(authThrottle.windowStartedAt, new Date(now.getTime() - AUTH_THROTTLE_RETENTION_MS))),
      and(known, lt(authThrottle.windowStartedAt, new Date(now.getTime() - KNOWN_CLIENT_RETENTION_MS))),
    ),
  )).returning({ key: authThrottle.key });
  return gone.length;
}
