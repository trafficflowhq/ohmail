/**
 * THE MAILBOX OAuth CEREMONY STORE (cloud 0009) — mint, consume ONCE, prune.
 *
 * Three statements, beside the table they run against, for the reason `suspension.ts` gives about
 * itself: the single-use consumption is the security property of the whole redirect flow, and a
 * property expressed as "every caller remembers to write the predicate" is not a property. There is
 * one writer of `consumed_at` and it is {@link consumeOAuthCeremony}.
 *
 * ── THE CONSUME IS ONE UPDATE, AND THAT IS THE ENTIRE REPLAY DEFENCE ──────────────────────
 *
 *     UPDATE mailbox_oauth_ceremonies
 *        SET consumed_at = now
 *      WHERE state = $1 AND consumed_at IS NULL
 *   RETURNING …
 *
 * Not `SELECT … then UPDATE`. Two browsers replaying one authorization code — a double-clicked
 * consent, a prefetching client, an attacker resubmitting a captured redirect — arrive as two
 * UPDATEs on ONE ROW. Postgres serializes them on the row lock: the first sets `consumed_at` and
 * returns the row, the second re-evaluates `consumed_at IS NULL` against the committed value, finds
 * it false, and returns ZERO rows. There is no window between the read and the write for the second
 * one to occupy, which is exactly what a read-then-write version would create.
 *
 * **PGlite cannot see this.** A single-connection in-process engine has nothing to interleave, so
 * the read-then-write version passes there identically. The guard is
 * `test/oauth-ceremony.pg.test.ts` against real Postgres on :5433, which fires N
 * concurrent consumes of one state and asserts exactly one winner.
 *
 * ── THE TTL IS CHECKED AFTER THE CONSUME, NOT INSIDE IT ───────────────────────────────────
 *
 * `AND created_at > $now - $ttl` in the UPDATE would be tidier and it is wrong for this flow: an
 * expired row would return zero rows, which is the SAME answer as a replayed state and as a state
 * that never existed. Those need different sentences — "that took too long, start again" is
 * actionable, "that link is not valid" is not — so the age is judged on the RETURNED row.
 *
 * The row is still consumed on the expired path, deliberately: an aged-out state is dead for good
 * rather than dead until the clock is nudged.
 *
 * A state that matched no row and a state that was already spent are the SAME answer
 * (`"unknown"`), and that is also deliberate: distinguishing them would turn the callback into an
 * oracle for whether a given 256-bit value was ever issued.
 */
import { and, eq, isNull, lt } from "drizzle-orm";
import { mailboxOauthCeremonies } from "./schema-cloud.js";
import type { Tx } from "./change-log.js";

/**
 * HOW LONG A CONSENT MAY TAKE. Ten minutes.
 *
 * It bounds the window in which a captured redirect is worth anything, and it is generous enough
 * for the real ceremony: a person who has to sign in to Microsoft, approve a scope list and
 * possibly complete their own MFA. Microsoft's authorization codes are themselves short-lived
 * (minutes), so a longer TTL here would only keep rows alive past the point where the code they
 * pair with could still be redeemed.
 */
export const OAUTH_CEREMONY_TTL_MS = 10 * 60_000;

/**
 * How long a ceremony row is KEPT. One hour — six TTLs.
 *
 * Long enough that the row is still there to explain a support question ("I clicked it and nothing
 * happened"), short enough that the table is bounded by the last hour of traffic rather than by all
 * of history. The prune is opportunistic (see {@link pruneOAuthCeremonies}).
 */
export const OAUTH_CEREMONY_RETENTION_MS = 60 * 60_000;

export interface OAuthCeremonyRow {
  state: string;
  accountId: string;
  provider: string;
  codeVerifierEnc: string;
  codeVerifierKeyVersion: number;
  returnTo: string | null;
  createdAt: Date;
  consumedAt: Date | null;
}

export interface CreateOAuthCeremonyInput {
  /** 256-bit random, base64url. Minted by the caller — this module does not own the RNG. */
  state: string;
  accountId: string;
  provider: string;
  codeVerifierEnc: string;
  codeVerifierKeyVersion: number;
  returnTo?: string | null;
  now: Date;
}

/** Record a ceremony in flight. The `state` PK makes a collision a 23505 rather than an overwrite. */
export async function createOAuthCeremony(tx: Tx, input: CreateOAuthCeremonyInput): Promise<void> {
  await tx.insert(mailboxOauthCeremonies).values({
    state: input.state,
    accountId: input.accountId,
    provider: input.provider,
    codeVerifierEnc: input.codeVerifierEnc,
    codeVerifierKeyVersion: input.codeVerifierKeyVersion,
    returnTo: input.returnTo ?? null,
    createdAt: input.now,
  });
}

/**
 * The three answers.
 *
 * `"ok"` carries the row. `"expired"` carries it too — the caller needs `returnTo` to send the
 * browser somewhere with a sentence on it. `"unknown"` carries nothing, because there is nothing:
 * a state that never existed and one already spent are the same answer by design.
 */
export type ConsumeOAuthCeremonyOutcome =
  | { outcome: "ok"; row: OAuthCeremonyRow }
  | { outcome: "expired"; row: OAuthCeremonyRow }
  | { outcome: "unknown" };

export interface ConsumeOAuthCeremonyInput {
  state: string;
  now: Date;
  ttlMs?: number;
}

/** Spend a ceremony exactly once. See the module header — this is the whole replay defence. */
export async function consumeOAuthCeremony(
  tx: Tx, input: ConsumeOAuthCeremonyInput,
): Promise<ConsumeOAuthCeremonyOutcome> {
  // An empty `state` must never be a predicate that could match a row. It cannot today (the column
  // is NOT NULL and every writer supplies 43 base64url characters), and the check is here because a
  // falsy value reaching a `WHERE state = ''` is one typo away from being the callback's happy path.
  if (!input.state) return { outcome: "unknown" };
  const [row] = await tx.update(mailboxOauthCeremonies)
    .set({ consumedAt: input.now })
    .where(and(
      eq(mailboxOauthCeremonies.state, input.state),
      isNull(mailboxOauthCeremonies.consumedAt),
    ))
    .returning();
  if (!row) return { outcome: "unknown" };
  const out: OAuthCeremonyRow = {
    state: row.state,
    accountId: row.accountId,
    provider: row.provider,
    codeVerifierEnc: row.codeVerifierEnc,
    codeVerifierKeyVersion: row.codeVerifierKeyVersion,
    returnTo: row.returnTo,
    createdAt: row.createdAt,
    consumedAt: row.consumedAt,
  };
  const ttl = input.ttlMs ?? OAUTH_CEREMONY_TTL_MS;
  if (input.now.getTime() - out.createdAt.getTime() > ttl) return { outcome: "expired", row: out };
  return { outcome: "ok", row: out };
}

/**
 * Drop ceremonies older than the retention window.
 *
 * OPPORTUNISTIC, called by the START handler rather than by a cron, and that is a deliberate
 * refusal to add a scheduled surface for a table whose whole content is the last hour of consent
 * clicks. It costs one indexed DELETE on the path that is already writing a row, it is keyed by the
 * `mailbox_oauth_ceremonies_created_idx` the migration creates, and a deployment that never runs a
 * ceremony has nothing to prune. A failure is the caller's to swallow: a table that grew by one row
 * is not a reason to refuse somebody's connect.
 */
export async function pruneOAuthCeremonies(
  tx: Tx, opts: { now: Date; retentionMs?: number },
): Promise<void> {
  const cutoff = new Date(opts.now.getTime() - (opts.retentionMs ?? OAUTH_CEREMONY_RETENTION_MS));
  await tx.delete(mailboxOauthCeremonies).where(lt(mailboxOauthCeremonies.createdAt, cutoff));
}
