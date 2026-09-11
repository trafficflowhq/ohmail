import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { refreshTokens, sessions, type Tx } from "@trafficflow/db";

/**
 * The web-session reaper — maintenance revocation of long-idle plain browser sessions, which
 * otherwise sit live-but-idle for ever. It revokes plain web sessions UNSEEN for over sixty days:
 * an active browser re-stamps `last_seen_at` on every rotation, so only a browser silent for two
 * months meets a sign-in prompt on return. Structural scope: `device_id IS NULL` (a paired device
 * is NEVER auto-reaped — re-pairing has a ceremony cost re-login does not), `scope = 'full'`, and
 * the whole refresh FAMILY dies with the session. Run by the hosted API's cron on the RUNTIME
 * connection; hosted barrel only. Bounded and convergent: at most `limit` per run, chunks of 500,
 * each a GUARDED update so a concurrent revocation counts once.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const CHUNK = 500;

export interface ReapResult {
  /** Sessions this run actually revoked (the guarded claims, not the candidate count). */
  reaped: number;
}

export async function reapStaleWebSessions(
  db: Tx,
  now: Date,
  opts: { olderThanMs?: number; limit?: number } = {},
): Promise<ReapResult> {
  const olderThanMs = opts.olderThanMs ?? 60 * DAY_MS;
  const budget = Math.min(Math.max(1, opts.limit ?? 5_000), 20_000);
  const cutoff = new Date(now.getTime() - olderThanMs);

  const candidates = await db.select({ id: sessions.id }).from(sessions)
    .where(and(
      isNull(sessions.deviceId),
      eq(sessions.scope, "full"),
      isNull(sessions.revokedAt),
      lt(sessions.lastSeenAt, cutoff),
    ))
    .limit(budget);

  let reaped = 0;
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const ids = candidates.slice(i, i + CHUNK).map((r) => r.id);
    // The claim re-states the WHOLE predicate, the cutoff included, not just the id list: a
    // session revoked (or paired — impossible today, but the predicate should not depend on
    // that) between the read and this write is skipped, and — the arm the review caught
    // missing — a session that ROTATED in that window (`mintRotation` stamps `last_seen_at`
    // current) is a browser that just came back to life, which a maintenance pass must not
    // sign out. Only rows THIS statement flipped count.
    const claimed = await db.update(sessions)
      .set({ revokedAt: now })
      .where(and(
        inArray(sessions.id, ids),
        isNull(sessions.deviceId),
        eq(sessions.scope, "full"),
        isNull(sessions.revokedAt),
        lt(sessions.lastSeenAt, cutoff),
      ))
      .returning({ familyId: sessions.familyId });
    if (claimed.length > 0) {
      await db.update(refreshTokens)
        .set({ revokedAt: now })
        .where(and(
          inArray(refreshTokens.familyId, [...new Set(claimed.map((c) => c.familyId))]),
          isNull(refreshTokens.revokedAt),
        ));
    }
    reaped += claimed.length;
  }
  return { reaped };
}
