import { and, isNull, like, lt, lte, not, or, sql } from "drizzle-orm";
import { authThrottle } from "./schema-cloud.js";
import type { Tx } from "./change-log.js";
import { affected, RETENTION_DELETE_BATCH } from "./change-log-retention.js";
import { SIGN_IN_RETENTION_DEADLINE_MS } from "./sign-in-retention.js";

/**
 * HOW LONG A THROTTLE ROW OUTLIVES ITS WINDOW. One constant, never a policy re-derived here: the
 * longest window plus lockout any writer uses (the pre-session factor cap, 24 h + 24 h) must fit
 * under it, and `auth-throttle-retention.test.ts` pins every writer's policy against it.
 */
export const AUTH_THROTTLE_RETENTION_MS = 48 * 60 * 60 * 1000;

/** A client that completed a sign-in stays known this long after its last one. */
export const KNOWN_CLIENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface AuthThrottlePruneOptions {
  /** Rows one statement takes. */
  batch?: number;
  /** The whole call's wall-clock bound; what it leaves, the next pass finds. */
  deadlineMs?: number;
  /** Injected so a test drives the deadline without waiting for it. */
  clock?: () => number;
}

/**
 * Delete throttle rows past retention that hold no live lock — every prefix, including the typed
 * addresses stored in the clear before the keys were hashed. Run from the worker's maintenance
 * pass; nothing else deletes these rows but an account's erasure. In statements of at most `batch`
 * rows, passing over a row another transaction holds, until a short one or the clock: one delete
 * over a sprayed backlog could pass the worker's statement timeout and roll back every hour.
 */
export async function pruneAuthThrottle(tx: Tx, now: Date, opts: AuthThrottlePruneOptions = {}): Promise<number> {
  const batch = opts.batch ?? RETENTION_DELETE_BATCH;
  const deadlineMs = opts.deadlineMs ?? SIGN_IN_RETENTION_DEADLINE_MS;
  const clock = opts.clock ?? Date.now;
  const startedAt = clock();
  const known = like(authThrottle.key, "known:%");
  const past = and(
    or(isNull(authThrottle.lockedUntil), lte(authThrottle.lockedUntil, now)),
    or(
      and(not(known), lt(authThrottle.windowStartedAt, new Date(now.getTime() - AUTH_THROTTLE_RETENTION_MS))),
      and(known, lt(authThrottle.windowStartedAt, new Date(now.getTime() - KNOWN_CLIENT_RETENTION_MS))),
    ),
  );
  let total = 0;
  while (clock() - startedAt < deadlineMs) {
    const gone = affected(await tx.delete(authThrottle).where(sql`${authThrottle.id} = any(array(
      select ${authThrottle.id} from ${authThrottle} where ${past} limit ${batch} for update skip locked))`));
    total += gone;
    if (gone < batch) break;
  }
  return total;
}
