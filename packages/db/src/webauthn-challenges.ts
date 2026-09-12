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
 * How many expired rows ONE prune may delete — the reason this is safe on a request path.
 *
 * This table has never been pruned, so the FIRST prune after the upgrade faces every ceremony the
 * deployment has opened; unbounded, that whole backlog lands on one person's sign-in.
 *
 * Why 200 and not 1: the prune must out-run the growth it bounds. A ceremony start adds exactly
 * one row and removes up to 200, so a backlog of N drains in at most N/199 starts and the steady
 * state is the retention window rather than all of history.
 */
export const WEBAUTHN_CHALLENGE_PRUNE_LIMIT = 200;

/**
 * Delete expired challenges, at most {@link WEBAUTHN_CHALLENGE_PRUNE_LIMIT} per call.
 *
 * OPPORTUNISTIC, on the ceremony START doors rather than a scheduled pass, for
 * `pruneOAuthCeremonies`' reason: the only thing that grows this table is a ceremony start, so a
 * timer would be a new scheduled surface for a table nobody is writing to. Keyed by
 * `webauthn_challenges_expires_idx`, so nothing due is an empty range scan. Two statements, not `DELETE … WHERE id IN (SELECT … LIMIT n)`: the id read makes the
 * bound exact on both dialects, and an empty read returns rather than building an `IN ()`.
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
