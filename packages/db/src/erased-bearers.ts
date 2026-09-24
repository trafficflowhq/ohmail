import { and, eq, gt, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { accounts, refreshTokens, sessions } from "./schema-mail.js";
import { erasedBearers } from "./schema-cloud.js";
import type { Tx } from "./change-log.js";

/**
 * THE TOKENS OF AN ERASED ACCOUNT, KEPT BY HASH (cloud 0043) — written by the erasure, read by
 * the session door. The erasure deletes every session and refresh token of the account in the
 * transaction that stamps `accounts.erased_at`; without this record an installed app still
 * holding one is a stranger to the door and renews for ever. Hosted-only: it names a Cloud table,
 * so the engine's session door asks through `SessionLifecycle.bearerOfErasedAccount`.
 */

/**
 * Copy the account's LIVE access and refresh token hashes, each with its own expiry, BEFORE the
 * erasure deletes them — call it inside that transaction. `ON CONFLICT DO NOTHING` keeps a
 * retried erasure idempotent. Revoked, consumed or expired tokens authenticate nothing today and
 * are left out.
 */
export async function recordErasedBearers(tx: Tx, accountId: string, now: Date): Promise<number> {
  const at = sql`${now.toISOString()}::timestamptz`;
  // INSERT … SELECT, never a materialised list: the rows are the account's own and the erasure
  // deletes the same set next, so the statement's size is the database's problem, not a bind list.
  const access = await tx.insert(erasedBearers)
    .select(tx.select({
      tokenHash: sql<string>`${sessions.accessTokenHash}`.as("token_hash"),
      accountId: sessions.accountId,
      expiresAt: sessions.accessExpiresAt,
    }).from(sessions).where(and(
      eq(sessions.accountId, accountId), isNull(sessions.revokedAt),
      isNotNull(sessions.accessTokenHash), gt(sessions.accessExpiresAt, at),
    )))
    .onConflictDoNothing()
    .returning({ tokenHash: erasedBearers.tokenHash });
  const refresh = await tx.insert(erasedBearers)
    .select(tx.select({
      tokenHash: refreshTokens.tokenHash,
      accountId: refreshTokens.accountId,
      expiresAt: refreshTokens.expiresAt,
    }).from(refreshTokens).where(and(
      eq(refreshTokens.accountId, accountId), isNull(refreshTokens.revokedAt),
      isNull(refreshTokens.consumedAt), gt(refreshTokens.expiresAt, at),
    )))
    .onConflictDoNothing()
    .returning({ tokenHash: erasedBearers.tokenHash });
  return access.length + refresh.length;
}

/**
 * Does this token HASH belong to an account whose erasure committed? Reads the stamp itself
 * (`accounts.erased_at`), the fact the wall's pass and `DELETE /account` both write, so a row
 * outliving a restored account could not answer for it. One primary-key lookup.
 */
export async function isErasedBearer(tx: Tx, tokenHash: string, now: Date): Promise<boolean> {
  const rows = await tx.select({ one: sql<number>`1` })
    .from(erasedBearers)
    .innerJoin(accounts, eq(accounts.id, erasedBearers.accountId))
    .where(and(
      eq(erasedBearers.tokenHash, tokenHash),
      gt(erasedBearers.expiresAt, sql`${now.toISOString()}::timestamptz`),
      isNotNull(accounts.erasedAt),
    ))
    .limit(1);
  return rows.length > 0;
}

/** Delete every row past its expiry — the worker's hourly maintenance. */
export async function pruneErasedBearers(tx: Tx, now: Date): Promise<number> {
  const gone = await tx.delete(erasedBearers)
    .where(lte(erasedBearers.expiresAt, sql`${now.toISOString()}::timestamptz`))
    .returning({ tokenHash: erasedBearers.tokenHash });
  return gone.length;
}
