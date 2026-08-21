import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { refreshTokens, sessions, type Tx } from "@trafficflow/db";

/**
 * ═══ THE WEB-SESSION REAPER — maintenance revocation of long-idle plain browser sessions ═══
 *
 * A browser sign-in mints a session and nothing ever retires it: the cookie window is 90 days
 * ROLLING, so a session that stops being presented simply stops rolling and sits in `sessions`
 * live-but-idle for ever. On a well-used account that is hundreds of rows (the flood the
 * Devices pane showed its owner), every one of them nominally a live credential.
 *
 * This pass revokes the stale ones on a policy cutoff: a plain web session UNSEEN for over
 * sixty days is signed out. Sixty days of silence is well past any tab that is coming back —
 * an ACTIVE browser re-stamps `last_seen_at` on every refresh rotation (`mintRotation`), so
 * only a browser that has not presented its credential at all in two months is touched, and
 * what such a browser experiences on return is a sign-in prompt, which is the correct answer
 * to "where has this cookie been since June".
 *
 * ── WHAT IT MAY TOUCH, STRUCTURALLY ────────────────────────────────────────────────────────
 *
 *  · `device_id IS NULL` — plain browser sessions ONLY. A device row means a NAMED device (a
 *    pairing redeem's mint, the desktop's macos claim), and a paired device is NEVER
 *    auto-reaped: an idle phone in a drawer keeps its pairing, because re-pairing has a
 *    ceremony cost that idle-web-sign-in re-login does not. The discriminator is the column,
 *    never a label or a kind, so nothing a user typed can move a device across the line.
 *  · `scope = 'full'` — enrollment sessions have their own five-minute death
 *    (`refreshExpiresAt = accessExpiresAt`) and their own supersession rules; a maintenance
 *    pass has no business re-deciding them.
 *  · the whole refresh FAMILY dies with the session — the same `revoked_at` sweep
 *    `revokeFamily` performs, so a held `tf_refresh` cannot resurrect a reaped session.
 *
 * ── WHO RUNS IT ────────────────────────────────────────────────────────────────────────────
 *
 * The hosted API's platform cron (`GET /internal/sessions/reap`, shared-secret gated, daily) —
 * see `routes/internal.ts`. It runs on the RUNTIME connection deliberately: revoking sessions
 * is session machinery, a grant the content-blind staff role does not hold and must not gain.
 * Nothing on the desktop tier calls it (there, the device-less session is the launch session).
 *
 * Exported from the HOSTED barrel only — never the `/auth` engine entry: a hosted maintenance
 * pass has no business in the public engine artifact's graph, and `auth-entry-census.test.ts`
 * would rightly refuse the growth.
 *
 * ── BOUNDED, AND CONVERGENT ACROSS RUNS ────────────────────────────────────────────────────
 *
 * One invocation claims at most `limit` sessions (default 5 000), in chunks of 500, each chunk
 * a GUARDED update (`revoked_at IS NULL` re-checked in the write) so a concurrent revocation —
 * a user's own bulk sign-out racing the cron — is counted once, never twice. A backlog larger
 * than the budget converges over successive daily runs instead of one invocation timing out
 * mid-family on a serverless host.
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
    // The claim re-states the whole predicate, not just the id list: a session revoked (or
    // paired — impossible today, but the predicate should not depend on that) between the
    // read and this write is skipped, and only rows THIS statement flipped count.
    const claimed = await db.update(sessions)
      .set({ revokedAt: now })
      .where(and(
        inArray(sessions.id, ids),
        isNull(sessions.deviceId),
        eq(sessions.scope, "full"),
        isNull(sessions.revokedAt),
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
