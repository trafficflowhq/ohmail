import { asc, lt, inArray } from "drizzle-orm";
import { webauthnChallenges } from "./schema-cloud.js";
import type { Tx } from "./change-log.js";

/**
 * THE PASSKEY CEREMONY TABLE'S RETENTION (cloud 0034).
 *
 * One hour past a challenge's own `expires_at`. The row is already unusable at that instant —
 * `consumeChallenge` refuses an expired challenge — so the hour buys nothing but the ability to
 * answer "I pressed the passkey button and nothing happened", which is exactly what
 * {@link OAUTH_CEREMONY_RETENTION_MS} buys for the other ceremony table.
 */
export const WEBAUTHN_CHALLENGE_RETENTION_MS = 60 * 60_000;

/**
 * How many expired rows ONE prune may delete.
 *
 * The bound is the whole reason this is safe to run on a request path. The other ceremony table
 * has been pruned since its first row, so its sweep is always empty-ish; this table has never
 * been pruned, so the FIRST prune after the upgrade faces every ceremony the deployment has ever
 * opened. An unbounded `DELETE … WHERE expires_at < cutoff` would put that whole backlog on one
 * person's sign-in.
 *
 * Why 200 and not 1: the prune must out-run the growth it is bounding. Each ceremony start adds
 * exactly ONE row and removes up to 200, so a backlog of N drains in at most N/199 ceremonies and
 * the steady state is the last hour of traffic — the table is bounded by the retention window
 * rather than by all of history, which is the invariant this constant exists to make true.
 */
export const WEBAUTHN_CHALLENGE_PRUNE_LIMIT = 200;

/**
 * Delete expired challenges, at most {@link WEBAUTHN_CHALLENGE_PRUNE_LIMIT} per call, and answer
 * how many went.
 *
 * OPPORTUNISTIC, called by the ceremony START doors rather than by a scheduled pass, for
 * `pruneOAuthCeremonies`' reason verbatim: the table's whole content is the last hour of passkey
 * ceremonies, the only thing that grows it is a ceremony start, and a pass on a timer would be a
 * new scheduled surface for a table that nobody is writing to when nobody is signing in. Keyed by
 * `webauthn_challenges_expires_idx`, so a deployment with nothing due pays an empty range scan.
 *
 * TWO STATEMENTS, not a `DELETE … WHERE id IN (SELECT … LIMIT n)`: the id read is what makes the
 * bound exact on both dialects, and an empty read returns here rather than building an `IN ()`.
 */
export async function pruneWebauthnChallenges(
  tx: Tx,
  opts: { now: Date; retentionMs?: number; limit?: number } = { now: new Date() },
): Promise<number> {
  const cutoff = new Date(
    opts.now.getTime() - (opts.retentionMs ?? WEBAUTHN_CHALLENGE_RETENTION_MS),
  );
  const limit = opts.limit ?? WEBAUTHN_CHALLENGE_PRUNE_LIMIT;
  const due = await tx
    .select({ id: webauthnChallenges.id })
    .from(webauthnChallenges)
    .where(lt(webauthnChallenges.expiresAt, cutoff))
    .orderBy(asc(webauthnChallenges.expiresAt))
    .limit(limit);
  if (due.length === 0) return 0;
  await tx.delete(webauthnChallenges)
    .where(inArray(webauthnChallenges.id, due.map((r) => r.id)));
  return due.length;
}
