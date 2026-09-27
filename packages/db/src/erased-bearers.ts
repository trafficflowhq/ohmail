import { and, desc, eq, gt, isNotNull, isNull, lte, sql } from "drizzle-orm";
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
 * retried erasure idempotent. Each live family's NEWEST consumed token is kept too: a client whose
 * rotation answer was lost still holds it and retries with it. Older consumed, revoked and
 * expired tokens authenticate nothing and are left out, so the record never grows with history.
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
  const spent = await tx.insert(erasedBearers)
    .select(tx.selectDistinctOn([refreshTokens.familyId], {
      tokenHash: refreshTokens.tokenHash,
      accountId: refreshTokens.accountId,
      expiresAt: refreshTokens.expiresAt,
    }).from(refreshTokens).where(and(
      eq(refreshTokens.accountId, accountId), isNull(refreshTokens.revokedAt),
      isNotNull(refreshTokens.consumedAt), gt(refreshTokens.expiresAt, at),
    )).orderBy(refreshTokens.familyId, desc(refreshTokens.consumedAt)))
    .onConflictDoNothing()
    .returning({ tokenHash: erasedBearers.tokenHash });
  return access.length + refresh.length + spent.length;
}

/**
 * The account this token HASH belonged to, when that account's erasure committed; else `null`.
 * Reads the stamp itself (`accounts.erased_at`), the fact the wall's pass and `DELETE /account`
 * both write, so a row outliving a restored account could not answer for it. The id is the one
 * every answer to that token already carried, so it tells the holder nothing new. One lookup.
 */
export async function erasedBearerAccount(tx: Tx, tokenHash: string, now: Date): Promise<string | null> {
  const rows = await tx.select({ accountId: erasedBearers.accountId })
    .from(erasedBearers)
    .innerJoin(accounts, eq(accounts.id, erasedBearers.accountId))
    .where(and(
      eq(erasedBearers.tokenHash, tokenHash),
      gt(erasedBearers.expiresAt, sql`${now.toISOString()}::timestamptz`),
      isNotNull(accounts.erasedAt),
    ))
    .limit(1);
  return rows[0]?.accountId ?? null;
}

/** Delete every row past its expiry — the worker's hourly maintenance. */
export async function pruneErasedBearers(tx: Tx, now: Date): Promise<number> {
  const gone = await tx.delete(erasedBearers)
    .where(lte(erasedBearers.expiresAt, sql`${now.toISOString()}::timestamptz`))
    .returning({ tokenHash: erasedBearers.tokenHash });
  return gone.length;
}
